/**
 * Telegram Inbound Router (SLICE v0).
 *
 * Deterministic router for Telegram commands, attached agent prompts,
 * ephemeral project resolution, stale message guards, and dialog replies.
 *
 * Contract:
 * - Fail-closed on unauthorized chat_id.
 * - Stale message timestamp guard (delta > 180s) -> offer [ Execute Stale ] button.
 * - Slash commands: /use, /where, /projects, /herd, /fresh, /stop (zero model tokens).
 * - Live attach -> dispatch prompt to attached daemon; stream/reply with prefix.
 * - Unattached -> stash prompt in 90s ephemeral cache and prompt with project buttons.
 * - Dialog replies -> route through NotificationDispatcher / dialog-reply idempotency.
 */

import { randomUUID } from "node:crypto";
import type { DaemonConnector } from "../connector";
import type { Registry, RegistryEntry } from "../registry";
import type { SpawnSupervisor } from "../supervisor";
import type { HerdProjector, HerdDaemonSnapshot } from "../projector";
import { promptEntry, type PromptResult } from "../fanout";
import type { NotificationDispatcher } from "./dispatcher";
import type { TelegramDispatcher, TelegramInboundMessage, TelegramCallback } from "./telegram";
import {
	EphemeralPromptCache,
	TelegramAttachStore,
	type TelegramAttachState,
} from "./telegram-attach";
import { redactForNotify } from "./redact";

export interface TelegramInboundDeps {
	registry: Registry;
	connector: DaemonConnector;
	supervisor: SpawnSupervisor;
	projector: HerdProjector;
	dispatcher: TelegramDispatcher;
	attachStore: TelegramAttachStore;
	promptCache?: EphemeralPromptCache;
	notifications: NotificationDispatcher;
	ownerChatId: string;
	staleTimeoutSec?: number;
	onDialogReply?: (binding: { epochToken: string; action: string; result?: unknown }) => Promise<void> | void;
}

const DEFAULT_STALE_TIMEOUT_SEC = 180; // 3 minutes
const SECRET_RE = /\b(?:sk-|ghp_|gho_|xox[baprs]-|Bearer\s+)[A-Za-z0-9._\-\/=+]{8,}\b/gi;

function redactSecrets(text: string): string {
	return text.replace(SECRET_RE, "[redacted]");
}

function formatTokens(usage: unknown): string {
	if (typeof usage !== "object" || usage === null) return "0";
	const rec = usage as Record<string, unknown>;
	const total =
		typeof rec.totalTokens === "number"
			? rec.totalTokens
			: typeof rec.inputTokens === "number" && typeof rec.outputTokens === "number"
				? rec.inputTokens + rec.outputTokens
				: 0;
	if (total <= 0) return "0";
	if (total >= 1000) return `${Math.round(total / 1000)}k`;
	return `${total}`;
}

export class TelegramInboundRouter {
	readonly #deps: TelegramInboundDeps;
	readonly #promptCache: EphemeralPromptCache;
	readonly #staleTimeoutSec: number;
	#activeTurns = new Set<string>();

	constructor(deps: TelegramInboundDeps) {
		this.#deps = deps;
		this.#promptCache = deps.promptCache ?? new EphemeralPromptCache();
		this.#staleTimeoutSec = deps.staleTimeoutSec ?? DEFAULT_STALE_TIMEOUT_SEC;

		// Wire inbound dispatcher events
		this.#deps.dispatcher.onMessage = (msg) => this.handleMessage(msg);
		this.#deps.dispatcher.onCallback = (cb) => this.handleCallback(cb);
	}

	get promptCache(): EphemeralPromptCache {
		return this.#promptCache;
	}

	get attachStore(): TelegramAttachStore {
		return this.#deps.attachStore;
	}

	async handleMessage(msg: TelegramInboundMessage): Promise<void> {
		// 1. Silent drop on non-owner chat
		if (msg.chatId !== this.#deps.ownerChatId) return;

		const nowSec = Math.floor(Date.now() / 1000);
		const deltaSec = nowSec - msg.date;

		// 2. Stale message guard (Mac wake-up protection)
		if (deltaSec > this.#staleTimeoutSec) {
			const promptId = this.#promptCache.put(msg.text, msg.chatId, msg.date);
			await this.#deps.dispatcher.send({
				chatId: msg.chatId,
				body: `⚠️ *Stale message detected* (sent ${deltaSec}s ago).\nTap below to execute:`,
				buttons: [{ text: "▶️ Execute Stale", callbackId: `stale:${promptId}` }],
				parseMode: "Markdown",
			});
			return;
		}

		const text = msg.text.trim();

		// 3. Slash commands
		if (text.startsWith("/")) {
			await this.#handleCommand(text, msg.chatId);
			return;
		}

		// 4. Untagged work message
		const attach = this.#deps.attachStore.get(msg.chatId);
		if (attach) {
			await this.#dispatchTurn(attach, text, msg.chatId);
			return;
		}

		// 5. Unattached -> stash in ephemeral cache and ask for project
		const promptId = this.#promptCache.put(text, msg.chatId, msg.date);
		await this.#sendProjectButtons(
			msg.chatId,
			promptId,
			"Which project? (Tap to attach and execute prompt)",
		);
	}

	async handleCallback(cb: TelegramCallback): Promise<void> {
		const chatId = cb.chatId ?? this.#deps.ownerChatId;
		if (chatId !== this.#deps.ownerChatId) return;

		const data = cb.callbackId;

		// 1. Dialog action callback (short id like t1, t2...)
		if (data.startsWith("t")) {
			const binding = this.#deps.notifications.takeCallback(data);
			if (binding) {
				await this.#deps.dispatcher.answerCallback(cb.callbackQueryId, "Action applied");
				await this.#deps.onDialogReply?.(binding);
			} else {
				await this.#deps.dispatcher.answerCallback(cb.callbackQueryId, "Dialog expired or already resolved");
			}
			return;
		}

		// 2. Project selection callback: p:<projectId> or p:<projectId>:<promptId>
		if (data.startsWith("p:")) {
			const parts = data.slice(2).split(":");
			const projectId = parts[0];
			const promptId = parts[1];

			const resolved = this.#resolveProject(projectId);
			if (!resolved) {
				await this.#deps.dispatcher.answerCallback(cb.callbackQueryId, "Project not found");
				return;
			}

			// Attach to project's daemon
			const attach: TelegramAttachState = {
				chatId,
				projectId: resolved.project.projectId,
				daemonId: resolved.entry.daemonId,
				sessionFile: resolved.entry.lastSessionFile,
				attachedAt: Date.now(),
				lastTurnAt: Date.now(),
			};
			this.#deps.attachStore.set(attach);

			await this.#deps.dispatcher.answerCallback(
				cb.callbackQueryId,
				`Attached to ${resolved.project.name}`,
			);

			if (promptId) {
				const cached = this.#promptCache.take(promptId);
				if (cached) {
					await this.#dispatchTurn(attach, cached.text, chatId);
					return;
				}
				await this.#deps.dispatcher.send({
					chatId,
					body: `now: *${resolved.project.name}* · \`${resolved.entry.daemonId}\` · ${resolved.entry.status}\n_(prompt expired after 90s)_`,
					parseMode: "Markdown",
				});
				return;
			}

			await this.#deps.dispatcher.send({
				chatId,
				body: `now: *${resolved.project.name}* · \`${resolved.entry.daemonId}\` · ${resolved.entry.status}`,
				parseMode: "Markdown",
			});
			return;
		}

		// 3. Stale prompt callback: stale:<promptId>
		if (data.startsWith("stale:")) {
			const promptId = data.slice(6);
			const cached = this.#promptCache.take(promptId);
			if (!cached) {
				await this.#deps.dispatcher.answerCallback(cb.callbackQueryId, "Prompt expired");
				return;
			}

			await this.#deps.dispatcher.answerCallback(cb.callbackQueryId, "Executing prompt");

			const attach = this.#deps.attachStore.get(chatId);
			if (attach) {
				await this.#dispatchTurn(attach, cached.text, chatId);
			} else {
				const newPromptId = this.#promptCache.put(cached.text, chatId);
				await this.#sendProjectButtons(
					chatId,
					newPromptId,
					"Which project? (Tap to attach and execute)",
				);
			}
			return;
		}

		await this.#deps.dispatcher.answerCallback(cb.callbackQueryId, "ok");
	}

	async #handleCommand(rawText: string, chatId: string): Promise<void> {
		const [cmd, ...args] = rawText.split(/\s+/);
		const command = cmd.toLowerCase();
		const target = args.join(" ").trim();

		switch (command) {
			case "/use": {
				if (!target) {
					await this.#sendProjectButtons(chatId, undefined, "Select a project to attach:");
					return;
				}
				const resolved = this.#resolveTarget(target);
				if (!resolved) {
					await this.#deps.dispatcher.send({
						chatId,
						body: `error: unknown project or daemon "${target}".\nUse /projects to see available targets.`,
					});
					return;
				}
				const attach: TelegramAttachState = {
					chatId,
					projectId: resolved.project.projectId,
					daemonId: resolved.entry.daemonId,
					sessionFile: resolved.entry.lastSessionFile,
					attachedAt: Date.now(),
					lastTurnAt: Date.now(),
				};
				this.#deps.attachStore.set(attach);

				const snapshot = this.#deps.projector.snapshot(this.#deps.registry.list());
				const snap = snapshot.daemons.find((d: HerdDaemonSnapshot) => d.daemonId === resolved.entry.daemonId);
				const status = snap?.status ?? resolved.entry.status;

				await this.#deps.dispatcher.send({
					chatId,
					body: `now: *${resolved.project.name}* · \`${resolved.entry.daemonId}\` · ${status}`,
					parseMode: "Markdown",
				});
				return;
			}

			case "/where": {
				const attach = this.#deps.attachStore.get(chatId);
				if (!attach) {
					await this.#deps.dispatcher.send({ chatId, body: "none" });
					return;
				}
				const resolved = this.#resolveProject(attach.projectId);
				const projectName = resolved?.project.name ?? attach.projectId;
				const entry = this.#deps.registry.get(attach.daemonId);
				const status = entry?.status ?? "asleep";

				await this.#deps.dispatcher.send({
					chatId,
					body: `attached: *${projectName}* · \`${attach.daemonId}\` · ${status}`,
					parseMode: "Markdown",
				});
				return;
			}

			case "/projects": {
				const projects = this.#deps.registry.projects();
				if (projects.length === 0) {
					await this.#deps.dispatcher.send({ chatId, body: "No projects registered in fleet." });
					return;
				}

				const lines = ["*Registered Projects:*"];
				const buttons: Array<{ text: string; callbackId: string }> = [];

				for (const p of projects) {
					const daemons = this.#deps.registry.list().filter((d: RegistryEntry) => d.projectId === p.projectId);
					const dList = daemons.map((d: RegistryEntry) => `${d.daemonId} (${d.status})`).join(", ");
					lines.push(`• *${p.projectId}*: ${p.name} \`${p.path}\`${dList ? ` — [${dList}]` : ""}`);
					buttons.push({ text: `${p.projectId}: ${p.name}`, callbackId: `p:${p.projectId}` });
				}

				await this.#deps.dispatcher.send({
					chatId,
					body: lines.join("\n"),
					buttons,
					parseMode: "Markdown",
				});
				return;
			}

			case "/herd": {
				const snapshot = this.#deps.projector.snapshot(this.#deps.registry.list());
				if (snapshot.daemons.length === 0) {
					await this.#deps.dispatcher.send({ chatId, body: "Herd is empty." });
					return;
				}

				const lines = ["*Fleet Herd:*"];
				for (const d of snapshot.daemons) {
					const branch = d.branch ? ` (${d.branch})` : "";
					const dialogs = d.pendingDialogs.length > 0 ? ` ⚠️ blocked on ${d.pendingDialogs.map((p) => p.method).join(", ")}` : "";
					lines.push(`• \`${d.daemonId}\` (${d.name}${branch}) · *${d.status}*${dialogs}`);
				}

				await this.#deps.dispatcher.send({
					chatId,
					body: lines.join("\n"),
					parseMode: "Markdown",
				});
				return;
			}

			case "/fresh": {
				const attach = this.#deps.attachStore.get(chatId);
				if (!attach) {
					await this.#deps.dispatcher.send({
						chatId,
						body: "not attached to any project. Use /use <project> first.",
					});
					return;
				}
				const entry = this.#deps.registry.get(attach.daemonId);
				if (!entry) {
					await this.#deps.dispatcher.send({ chatId, body: `daemon ${attach.daemonId} not found` });
					return;
				}

				try {
					const id = randomUUID();
					this.#deps.connector.send(attach.daemonId, {
						type: "call",
						id,
						method: "freshSession",
						args: [],
					});

					const resolved = this.#resolveProject(attach.projectId);
					const projectName = resolved?.project.name ?? attach.projectId;

					this.#deps.attachStore.touch(chatId);
					await this.#deps.dispatcher.send({
						chatId,
						body: `fresh session started for *${projectName}* · \`${attach.daemonId}\``,
						parseMode: "Markdown",
					});
				} catch (err) {
					await this.#deps.dispatcher.send({
						chatId,
						body: `failed to start fresh session: ${(err as Error).message}`,
					});
				}
				return;
			}

			case "/stop": {
				const attach = this.#deps.attachStore.get(chatId);
				if (!attach) {
					await this.#deps.dispatcher.send({ chatId, body: "not attached to any project." });
					return;
				}
				try {
					const id = randomUUID();
					this.#deps.connector.send(attach.daemonId, {
						type: "call",
						id,
						method: "abort",
						args: [],
					});
					const resolved = this.#resolveProject(attach.projectId);
					const projectName = resolved?.project.name ?? attach.projectId;
					await this.#deps.dispatcher.send({
						chatId,
						body: `stopped *${projectName}* · \`${attach.daemonId}\``,
						parseMode: "Markdown",
					});
				} catch (err) {
					await this.#deps.dispatcher.send({
						chatId,
						body: `failed to stop daemon: ${(err as Error).message}`,
					});
				}
				return;
			}

			default: {
				await this.#deps.dispatcher.send({
					chatId,
					body: `unknown command "${command}". Available: /use, /where, /projects, /herd, /fresh, /stop`,
				});
				return;
			}
		}
	}

	async #dispatchTurn(
		attach: TelegramAttachState,
		promptText: string,
		chatId: string,
	): Promise<void> {
		const entry = this.#deps.registry.get(attach.daemonId);
		if (!entry) {
			await this.#deps.dispatcher.send({
				chatId,
				body: `error: daemon \`${attach.daemonId}\` not found in fleet.`,
			});
			return;
		}

		const resolved = this.#resolveProject(attach.projectId);
		const projectName = resolved?.project.name ?? attach.projectId;

		this.#deps.attachStore.touch(chatId);
		this.#activeTurns.add(attach.daemonId);

		// Send initial typing indicator + heartbeat timer
		await this.#deps.dispatcher.sendChatAction(chatId, "typing");
		const typingTimer = setInterval(() => {
			void this.#deps.dispatcher.sendChatAction(chatId, "typing");
		}, 4500);

		try {
			const res: PromptResult = await promptEntry(
				{
					registry: this.#deps.registry,
					connector: this.#deps.connector,
					supervisor: this.#deps.supervisor,
				},
				entry,
				promptText,
			);

			clearInterval(typingTimer);
			this.#activeTurns.delete(attach.daemonId);
			this.#deps.attachStore.touch(chatId);

			if (!res.ok) {
				await this.#deps.dispatcher.send({
					chatId,
					body: `*${projectName}* · \`${attach.daemonId}\` · error\n${res.error ?? "turn failed"}`,
					parseMode: "Markdown",
				});
				return;
			}

			const tokens = formatTokens(res.usage);
			const header = `*${projectName}* · \`${attach.daemonId}\` · ~${tokens}`;
			const bodyText = redactSecrets(res.text ?? "done");
			const fullMessage = `${header}\n\n${bodyText}`;

			if (fullMessage.length <= 4000) {
				await this.#deps.dispatcher.send({
					chatId,
					body: fullMessage,
					parseMode: "Markdown",
				});
			} else {
				// Large output fallback: document attachment + summary caption
				const snippet = redactForNotify(bodyText, 300);
				await this.#deps.dispatcher.sendDocument({
					chatId,
					filename: `${projectName}-${attach.daemonId}-turn.md`,
					content: bodyText,
					caption: `${header}\n${snippet}`,
				});
			}
		} catch (err) {
			clearInterval(typingTimer);
			this.#activeTurns.delete(attach.daemonId);
			await this.#deps.dispatcher.send({
				chatId,
				body: `*${projectName}* · \`${attach.daemonId}\` · error\n${(err as Error).message}`,
				parseMode: "Markdown",
			});
		}
	}

	async #sendProjectButtons(
		chatId: string,
		promptId: string | undefined,
		promptMessage: string,
	): Promise<void> {
		const projects = this.#deps.registry.projects();
		if (projects.length === 0) {
			await this.#deps.dispatcher.send({
				chatId,
				body: "No projects registered in fleet.",
			});
			return;
		}

		const buttons: Array<{ text: string; callbackId: string }> = projects.map((p) => ({
			text: `${p.projectId}: ${p.name}`,
			callbackId: promptId ? `p:${p.projectId}:${promptId}` : `p:${p.projectId}`,
		}));

		await this.#deps.dispatcher.send({
			chatId,
			body: promptMessage,
			buttons,
		});
	}

	#resolveProject(projectId: string): { project: { projectId: string; name: string }; entry: RegistryEntry } | null {
		const projects = this.#deps.registry.projects();
		const p = projects.find((proj) => proj.projectId === projectId || proj.name === projectId);
		if (!p) return null;
		const daemons = this.#deps.registry.list().filter((d: RegistryEntry) => d.projectId === p.projectId);
		if (daemons.length === 0) return null;
		// Prefer ready or main daemon
		const entry = daemons.find((d: RegistryEntry) => d.status === "ready") ?? daemons[0];
		return { project: p, entry };
	}

	#resolveTarget(target: string): { project: { projectId: string; name: string }; entry: RegistryEntry } | null {
		// 1. Direct project match
		const byProj = this.#resolveProject(target);
		if (byProj) return byProj;

		// 2. Direct daemon match
		const byDaemon = this.#deps.registry.get(target);
		if (byDaemon) {
			const p = this.#deps.registry.projects().find((proj) => proj.projectId === byDaemon.projectId) ?? {
				projectId: byDaemon.projectId ?? byDaemon.daemonId,
				name: byDaemon.name,
			};
			return { project: p, entry: byDaemon };
		}

		// 3. Name or cwd substring match
		const allDaemons = this.#deps.registry.list();
		const matchedDaemon = allDaemons.find(
			(d: RegistryEntry) =>
				d.name.toLowerCase() === target.toLowerCase() ||
				(d.cwd && d.cwd.toLowerCase().endsWith(target.toLowerCase())),
		);
		if (matchedDaemon) {
			const p = this.#deps.registry.projects().find((proj) => proj.projectId === matchedDaemon.projectId) ?? {
				projectId: matchedDaemon.projectId ?? matchedDaemon.daemonId,
				name: matchedDaemon.name,
			};
			return { project: p, entry: matchedDaemon };
		}

		return null;
	}
}
