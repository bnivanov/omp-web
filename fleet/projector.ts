/**
 * In-memory herd read-model. Consumes daemon SSE frames + registry facts
 * and exposes a token-free snapshot for GET /ctl/herd.
 */

import type { ServerFrame, WebSessionState } from "../shared/protocol";
import type { RegistryEntry } from "./registry";

export type HerdLiveStatus = "idle" | "streaming" | "blocked_ui" | "error" | "offline";

export interface PendingDialog {
	requestId: string;
	method: string;
	params: unknown;
	epochToken: string;
}

export interface HerdDaemonSnapshot {
	daemonId: string;
	name: string;
	status: HerdLiveStatus;
	registryStatus: string;
	cwd?: string;
	branch?: string;
	worktreeOf?: string;
	projectId?: string;
	tool?: string;
	pendingDialogs: PendingDialog[];
	bootEpoch: number;
}

export interface HerdSnapshot {
	daemons: HerdDaemonSnapshot[];
}

interface DaemonProjection {
	bootEpoch: number;
	streaming: boolean;
	blocked: boolean;
	tool?: string;
	pending: Map<string, PendingDialog>;
}

function emptyProjection(): DaemonProjection {
	return { bootEpoch: 0, streaming: false, blocked: false, pending: new Map() };
}

export function makeEpochToken(daemonId: string, bootEpoch: number, requestId: string): string {
	return `${daemonId}:${bootEpoch}:${requestId}`;
}

export function parseEpochToken(
	token: string,
): { daemonId: string; bootEpoch: number; requestId: string } | null {
	const parts = token.split(":");
	if (parts.length < 3) return null;
	const requestId = parts[parts.length - 1]!;
	const bootRaw = parts[parts.length - 2]!;
	const daemonId = parts.slice(0, -2).join(":");
	const bootEpoch = Number(bootRaw);
	if (!daemonId || !requestId || !Number.isInteger(bootEpoch) || bootEpoch < 1) return null;
	return { daemonId, bootEpoch, requestId };
}

export class HerdProjector {
	readonly #daemons = new Map<string, DaemonProjection>();

	/** New ready session: bump epoch so leftover uiN ids cannot replay. */
	markReady(daemonId: string): number {
		const proj = this.#daemons.get(daemonId) ?? emptyProjection();
		proj.bootEpoch += 1;
		proj.streaming = false;
		proj.blocked = false;
		proj.tool = undefined;
		proj.pending.clear();
		this.#daemons.set(daemonId, proj);
		return proj.bootEpoch;
	}

	drop(daemonId: string): void {
		this.#daemons.delete(daemonId);
	}

	applyFrame(daemonId: string, frame: ServerFrame): void {
		const proj = this.#daemons.get(daemonId) ?? emptyProjection();
		if (proj.bootEpoch === 0) proj.bootEpoch = 1;
		this.#daemons.set(daemonId, proj);
		switch (frame.type) {
			case "state": {
				const state = frame.state as WebSessionState | undefined;
				if (state) proj.streaming = state.isStreaming === true;
				break;
			}
			case "ui_request": {
				if (typeof frame.id !== "string") break;
				const method = typeof frame.method === "string" ? frame.method : "unknown";
				proj.pending.set(frame.id, {
					requestId: frame.id,
					method,
					params: frame.params,
					epochToken: makeEpochToken(daemonId, proj.bootEpoch, frame.id),
				});
				proj.blocked = true;
				break;
			}
			case "ui_request_end": {
				if (typeof frame.id === "string") proj.pending.delete(frame.id);
				proj.blocked = proj.pending.size > 0;
				break;
			}
			case "event": {
				const payload = (frame as { payload?: unknown }).payload;
				const name = toolNameFromEvent(payload);
				if (name !== undefined) proj.tool = name;
				break;
			}
			default:
				break;
		}
	}

	getDialog(epochToken: string): PendingDialog | undefined {
		const parsed = parseEpochToken(epochToken);
		if (!parsed) return undefined;
		const proj = this.#daemons.get(parsed.daemonId);
		if (!proj || proj.bootEpoch !== parsed.bootEpoch) return undefined;
		return proj.pending.get(parsed.requestId);
	}

	getPending(daemonId: string, requestId: string): PendingDialog | undefined {
		return this.#daemons.get(daemonId)?.pending.get(requestId);
	}

	clearDialog(epochToken: string): void {
		const parsed = parseEpochToken(epochToken);
		if (!parsed) return;
		const proj = this.#daemons.get(parsed.daemonId);
		if (!proj || proj.bootEpoch !== parsed.bootEpoch) return;
		proj.pending.delete(parsed.requestId);
		proj.blocked = proj.pending.size > 0;
	}

	snapshot(entries: readonly RegistryEntry[]): HerdSnapshot {
		const daemons: HerdDaemonSnapshot[] = [];
		for (const entry of entries) {
			const proj = this.#daemons.get(entry.daemonId);
			daemons.push({
				daemonId: entry.daemonId,
				name: entry.name,
				status: liveStatus(entry, proj),
				registryStatus: entry.status,
				cwd: entry.cwd || undefined,
				branch: entry.branch,
				worktreeOf: entry.worktreeOf,
				projectId: entry.projectId,
				tool: proj?.tool,
				pendingDialogs: proj ? [...proj.pending.values()] : [],
				bootEpoch: proj?.bootEpoch ?? 0,
			});
		}
		return { daemons };
	}
}

function liveStatus(entry: RegistryEntry, proj: DaemonProjection | undefined): HerdLiveStatus {
	if (entry.status === "error") return "error";
	if (entry.status !== "ready") return "offline";
	if (proj?.blocked) return "blocked_ui";
	if (proj?.streaming) return "streaming";
	return "idle";
}

function toolNameFromEvent(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const rec = payload as Record<string, unknown>;
	if (typeof rec.toolName === "string") return rec.toolName;
	if (typeof rec.name === "string" && rec.type === "tool_execution_start") return rec.name;
	return undefined;
}
