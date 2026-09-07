import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../registry";
import { DaemonConnector } from "../connector";
import { SpawnSupervisor } from "../supervisor";
import { HerdProjector } from "../projector";
import { TelegramDispatcher, type TelegramInboundMessage, type TelegramCallback } from "./telegram";
import { TelegramAttachStore, EphemeralPromptCache } from "./telegram-attach";
import { TelegramInboundRouter } from "./telegram-inbound";
import { NotificationDispatcher } from "./dispatcher";
import { startFakeDaemon, waitFor, cleanupTempDirs, type FakeDaemon } from "../server.testkit";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "tg-inbound-test-"));
}

describe("TelegramInboundRouter", () => {
	let tmpDir: string;
	let statePath: string;
	let attachPath: string;
	let projADir: string;
	let projBDir: string;
	let registry: Registry;
	let projector: HerdProjector;
	let attachStore: TelegramAttachStore;
	let promptCache: EphemeralPromptCache;
	let sentMessages: Array<{ chat_id?: string; text: string; reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> }; parse_mode?: string }>;
	let sentDocuments: Array<{ filename: string; content: string | Uint8Array; caption?: string }>;
	let sentChatActions: Array<{ chat_id?: string; action: string }>;
	let answeredCallbacks: Array<{ id: string; text: string }>;
	let fakeTelegram: TelegramDispatcher;
	let notifications: NotificationDispatcher;
	let router: TelegramInboundRouter;
	let connector: DaemonConnector;
	let supervisor: SpawnSupervisor;
	let fakeD1: FakeDaemon | undefined;
	let fakeD2: FakeDaemon | undefined;
	let lastDialogReply: { epochToken: string; action: string; result?: unknown } | undefined;
	const ownerChatId = "12345678";

	beforeEach(async () => {
		tmpDir = makeTmpDir();
		statePath = join(tmpDir, "fleet-state.json");
		attachPath = join(tmpDir, "telegram-attach.json");

		projADir = join(tmpDir, "proj-a");
		projBDir = join(tmpDir, "proj-b");
		mkdirSync(join(projADir, ".git"), { recursive: true });
		mkdirSync(join(projBDir, ".git"), { recursive: true });

		registry = new Registry(statePath);
		await registry.load();

		await registry.addProject(projADir);
		await registry.addProject(projBDir);

		fakeD1 = startFakeDaemon("tok1", projADir);
		fakeD2 = startFakeDaemon("tok2", projBDir);

		registry.create({
			mode: "attached",
			status: "ready",
			name: "proj-a-main",
			project: "proj-a",
			projectId: "p1",
			cwd: projADir,
			endpoint: fakeD1.url,
			token: "tok1",
			labels: [],
		});

		registry.create({
			mode: "attached",
			status: "ready",
			name: "proj-b-main",
			project: "proj-b",
			projectId: "p2",
			cwd: projBDir,
			endpoint: fakeD2.url,
			token: "tok2",
			labels: [],
		});

		projector = new HerdProjector();
		attachStore = new TelegramAttachStore(attachPath, 4 * 3600 * 1000);
		promptCache = new EphemeralPromptCache(90 * 1000);

		sentMessages = [];
		sentDocuments = [];
		sentChatActions = [];
		answeredCallbacks = [];
		lastDialogReply = undefined;

		const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("sendMessage")) {
				sentMessages.push(JSON.parse(String(init?.body ?? "{}")));
			} else if (urlStr.includes("sendDocument")) {
				sentDocuments.push({ filename: "doc.md", content: "", caption: "" });
			} else if (urlStr.includes("sendChatAction")) {
				sentChatActions.push(JSON.parse(String(init?.body ?? "{}")));
			} else if (urlStr.includes("answerCallbackQuery")) {
				const b = JSON.parse(String(init?.body ?? "{}"));
				answeredCallbacks.push({ id: b.callback_query_id, text: b.text });
			}
			return new Response(JSON.stringify({ ok: true, result: {} }));
		}) as unknown as typeof fetch;

		fakeTelegram = new TelegramDispatcher(
			{ botToken: "dummy-token", chatId: ownerChatId },
			fakeFetch,
		);

		notifications = new NotificationDispatcher({ telegram: { botToken: "dummy-token", chatId: ownerChatId } }, fakeFetch);

		connector = new DaemonConnector(registry);
		supervisor = new SpawnSupervisor(registry, connector, {
			templates: {},
			defaultTemplate: "default",
			workspaceDir: tmpDir,
		});

		router = new TelegramInboundRouter({
			registry,
			connector,
			supervisor,
			projector,
			dispatcher: fakeTelegram,
			attachStore,
			promptCache,
			notifications,
			ownerChatId,
			staleTimeoutSec: 180,
			onDialogReply: (binding) => {
				lastDialogReply = binding;
			},
		});
	});

	afterEach(() => {
		fakeD1?.close();
		fakeD2?.close();
		connector?.close();
		supervisor?.close();
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	test("silent drop on non-owner chat_id", async () => {
		const msg: TelegramInboundMessage = {
			messageId: 1,
			chatId: "99999999", // non-owner
			text: "/where",
			date: Math.floor(Date.now() / 1000),
		};

		await router.handleMessage(msg);
		expect(sentMessages.length).toBe(0);
	});

	test("/where returns none when unattached", async () => {
		const msg: TelegramInboundMessage = {
			messageId: 2,
			chatId: ownerChatId,
			text: "/where",
			date: Math.floor(Date.now() / 1000),
		};

		await router.handleMessage(msg);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toBe("none");
	});

	test("/projects lists registered projects", async () => {
		const msg: TelegramInboundMessage = {
			messageId: 3,
			chatId: ownerChatId,
			text: "/projects",
			date: Math.floor(Date.now() / 1000),
		};

		await router.handleMessage(msg);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toContain("proj-a");
		expect(sentMessages[0].text).toContain("proj-b");
	});

	test("/herd returns clean snapshot without tokens", async () => {
		const msg: TelegramInboundMessage = {
			messageId: 4,
			chatId: ownerChatId,
			text: "/herd",
			date: Math.floor(Date.now() / 1000),
		};

		await router.handleMessage(msg);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toContain("Fleet Herd:");
		expect(sentMessages[0].text).not.toContain("token");
		expect(sentMessages[0].text).not.toContain("ws://");
	});

	test("/use attaches to specified project and updates attach store", async () => {
		const msg: TelegramInboundMessage = {
			messageId: 5,
			chatId: ownerChatId,
			text: "/use p1",
			date: Math.floor(Date.now() / 1000),
		};

		await router.handleMessage(msg);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toContain("now: *proj-a*");

		const attach = attachStore.get(ownerChatId);
		expect(attach).not.toBeNull();
		expect(attach?.projectId).toBe("p1");
		expect(attach?.daemonId).toBe("d1");

		// /where now confirms attach
		sentMessages = [];
		await router.handleMessage({
			messageId: 6,
			chatId: ownerChatId,
			text: "/where",
			date: Math.floor(Date.now() / 1000),
		});
		expect(sentMessages[0].text).toContain("attached: *proj-a* · `d1`");
	});

	test("turn prompt execution formats reply with project prefix", async () => {
		attachStore.set({
			chatId: ownerChatId,
			projectId: "p1",
			daemonId: "d1",
			attachedAt: Date.now(),
			lastTurnAt: Date.now(),
		});

		sentMessages = [];
		await router.handleMessage({
			messageId: 20,
			chatId: ownerChatId,
			text: "do work in p1",
			date: Math.floor(Date.now() / 1000),
		});

		await waitFor(() => sentMessages.length > 0, 5000, "telegram reply sent");
		expect(sentMessages[0].text).toContain("*proj-a* · `d1`");
		expect(sentMessages[0].text).toContain("fake reply");
	});

	test("unattached untagged prompt stashes in 90s cache and offers project buttons", async () => {
		const msg: TelegramInboundMessage = {
			messageId: 7,
			chatId: ownerChatId,
			text: "do something cool",
			date: Math.floor(Date.now() / 1000),
		};

		await router.handleMessage(msg);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toContain("Which project?");

		const buttons = sentMessages[0].reply_markup?.inline_keyboard;
		expect(buttons).toBeDefined();

		// Tapping project button attaches AND runs cached prompt
		const cbData = buttons![0][0].callback_data;
		expect(cbData).toMatch(/^p:p1:p_/);

		const cb: TelegramCallback = {
			callbackId: cbData,
			callbackQueryId: "q1",
			chatId: ownerChatId,
		};

		sentMessages = [];
		await router.handleCallback(cb);
		const attach = attachStore.get(ownerChatId);
		expect(attach?.projectId).toBe("p1");
		expect(answeredCallbacks.some((a) => a.id === "q1")).toBe(true);

		// Prompt was executed on p1
		await waitFor(() => sentMessages.length > 0, 5000, "cached prompt reply sent");
		expect(sentMessages[0].text).toContain("*proj-a* · `d1`");
		expect(sentMessages[0].text).toContain("fake reply");
	});

	test("stale message (>180s) triggers stale guard and offers Execute Stale button", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const msg: TelegramInboundMessage = {
			messageId: 8,
			chatId: ownerChatId,
			text: "delayed message from wake",
			date: nowSec - 300, // 5 minutes ago
		};

		await router.handleMessage(msg);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toContain("Stale message detected");

		const buttons = sentMessages[0].reply_markup?.inline_keyboard;
		const cbData = buttons![0][0].callback_data;
		expect(cbData).toMatch(/^stale:p_/);

		// Tapping stale button
		await router.handleCallback({
			callbackId: cbData,
			callbackQueryId: "q_stale",
			chatId: ownerChatId,
		});
		expect(answeredCallbacks.some((a) => a.id === "q_stale")).toBe(true);
	});

	test("attach expiry after TTL clears attach state", () => {
		attachStore.set({
			chatId: ownerChatId,
			projectId: "p1",
			daemonId: "d1",
			attachedAt: Date.now() - 5 * 3600 * 1000,
			lastTurnAt: Date.now() - 5 * 3600 * 1000, // 5 hours ago (> 4h TTL)
		});

		expect(attachStore.get(ownerChatId)).toBeNull();
	});

	test("dialog reply button resolution", async () => {
		await notifications.onDialog({
			daemonId: "d1",
			name: "proj-a-main",
			dialog: {
				requestId: "ui_ask_1",
				method: "confirm",
				params: { title: "Approve deployment?" },
				epochToken: "d1:1:ui_ask_1",
			},
		});

		expect(sentMessages.length).toBe(1);
		const buttons = sentMessages[0].reply_markup?.inline_keyboard;
		const yesButtonCb = buttons![0][0].callback_data;
		expect(yesButtonCb).toMatch(/^t\d+$/);

		// Tap Yes button in Telegram
		await router.handleCallback({
			callbackId: yesButtonCb,
			callbackQueryId: "q_dialog_1",
			chatId: ownerChatId,
		});

		expect(answeredCallbacks.some((a) => a.id === "q_dialog_1")).toBe(true);
		expect(lastDialogReply?.epochToken).toBe("d1:1:ui_ask_1");
		expect(lastDialogReply?.action).toBe("accept");
	});

	test("/fresh triggers freshSession on daemon", async () => {
		attachStore.set({
			chatId: ownerChatId,
			projectId: "p1",
			daemonId: "d1",
			attachedAt: Date.now(),
			lastTurnAt: Date.now(),
		});

		sentMessages = [];
		await router.handleMessage({
			messageId: 9,
			chatId: ownerChatId,
			text: "/fresh",
			date: Math.floor(Date.now() / 1000),
		});

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toContain("fresh session started for *proj-a* · `d1`");
	});

	test("/stop triggers abort on daemon", async () => {
		attachStore.set({
			chatId: ownerChatId,
			projectId: "p1",
			daemonId: "d1",
			attachedAt: Date.now(),
			lastTurnAt: Date.now(),
		});

		sentMessages = [];
		await router.handleMessage({
			messageId: 10,
			chatId: ownerChatId,
			text: "/stop",
			date: Math.floor(Date.now() / 1000),
		});

		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].text).toContain("stopped *proj-a* · `d1`");
	});
});
