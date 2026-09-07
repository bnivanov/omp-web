/**
 * Background observer: tap the connector while it is live; when the control
 * stream idle-drops, open a dedicated `/events?role=observer` so ui_request
 * and agent_end still reach the projector without pinning daemon idle-exit.
 */

import { SSE_EVENT_NAME, type ClientCommand, type ServerFrame } from "../shared/protocol";
import { parseSseUnits } from "../shared/sse";
import { daemonHttpBase } from "./connector";
import type { DaemonConnector } from "./connector";
import type { NotificationDispatcher } from "./notifications/dispatcher";
import type { HerdProjector } from "./projector";
import type { Registry, RegistryEntry } from "./registry";

export interface ObserverDeps {
	registry: Registry;
	connector: DaemonConnector;
	projector: HerdProjector;
	notifications: NotificationDispatcher;
}

interface ObserverDial {
	abort: AbortController;
}

export class ObserverBroker {
	readonly #registry: Registry;
	readonly #connector: DaemonConnector;
	readonly #projector: HerdProjector;
	readonly #notifications: NotificationDispatcher;
	readonly #unsub = new Map<string, () => void>();
	readonly #dials = new Map<string, ObserverDial>();
	#closed = false;

	constructor(deps: ObserverDeps) {
		this.#registry = deps.registry;
		this.#connector = deps.connector;
		this.#projector = deps.projector;
		this.#notifications = deps.notifications;
	}

	onStatus(entry: RegistryEntry): void {
		if (this.#closed) return;
		if (entry.status === "ready") {
			if (!this.#unsub.has(entry.daemonId)) {
				this.#projector.markReady(entry.daemonId);
				this.#watch(entry.daemonId);
			}
			return;
		}
		this.#unwatch(entry.daemonId);
	}

	onDisconnect(daemonId: string): void {
		if (this.#closed) return;
		const entry = this.#registry.get(daemonId);
		if (entry?.status !== "ready") return;
		if (this.#connector.isConnected(daemonId)) return;
		this.#dial(entry);
	}

	close(): void {
		this.#closed = true;
		for (const id of [...this.#unsub.keys()]) this.#unwatch(id);
	}

	#watch(daemonId: string): void {
		if (this.#unsub.has(daemonId)) return;
		const off = this.#connector.onFrame(daemonId, (frame) => {
			this.#onFrame(daemonId, frame);
		});
		this.#unsub.set(daemonId, off);
	}

	#unwatch(daemonId: string): void {
		this.#unsub.get(daemonId)?.();
		this.#unsub.delete(daemonId);
		const dial = this.#dials.get(daemonId);
		if (dial) {
			dial.abort.abort();
			this.#dials.delete(daemonId);
		}
	}

	#onFrame(daemonId: string, frame: ServerFrame): void {
		this.#projector.applyFrame(daemonId, frame);
		const entry = this.#registry.get(daemonId);
		if (!entry) return;
		if (frame.type === "ui_request") {
			const dialog = this.#projector.getPending(daemonId, frame.id);
			if (dialog) {
				void this.#notifications.onDialog({ daemonId, name: entry.name, dialog });
			}
		}
		if (frame.type === "event") {
			const preview = agentEndPreview(frame);
			if (preview !== undefined) {
				void this.#notifications.onTurnEnd({ daemonId, name: entry.name, preview });
			}
		}
	}

	#dial(entry: RegistryEntry): void {
		if (!entry.endpoint || this.#dials.has(entry.daemonId)) return;
		const abort = new AbortController();
		this.#dials.set(entry.daemonId, { abort });
		void this.#consume(entry, abort).finally(() => {
			const cur = this.#dials.get(entry.daemonId);
			if (cur?.abort === abort) this.#dials.delete(entry.daemonId);
		});
	}

	async #consume(entry: RegistryEntry, abort: AbortController): Promise<void> {
		const endpoint = entry.endpoint;
		if (!endpoint) return;
		try {
			const res = await fetch(`${daemonHttpBase(endpoint)}/events?role=observer`, {
				headers: { Authorization: `Bearer ${entry.token ?? ""}` },
				signal: abort.signal,
			});
			if (!res.ok || !res.body) return;
			for await (const unit of parseSseUnits(res.body)) {
				if (abort.signal.aborted) return;
				if (unit.kind !== "event" || unit.event !== SSE_EVENT_NAME) continue;
				let frame: ServerFrame;
				try {
					frame = JSON.parse(unit.data) as ServerFrame;
				} catch {
					continue;
				}
				this.#onFrame(entry.daemonId, frame);
			}
		} catch {
			// Abort or transport end — the next disconnect/ready re-dials.
		}
	}

	/** Test seam: is a dedicated observer stream open. */
	isDialing(daemonId: string): boolean {
		return this.#dials.has(daemonId);
	}
}

/** Preview text when the frame is an agent_end event; undefined otherwise. */
export function agentEndPreview(frame: ServerFrame): string | undefined {
	if (frame.type !== "event") return undefined;
	const ev = frame.event;
	if (typeof ev !== "object" || ev === null || !("type" in ev) || ev.type !== "agent_end") {
		return undefined;
	}
	if ("error" in ev && typeof ev.error === "string" && ev.error.length > 0) return ev.error;
	return "turn complete";
}

/** Build the ui_response the observer posts through the connector. */
export function dialogResponseCommand(requestId: string, result: unknown): ClientCommand {
	if (result === undefined) return { type: "ui_response", id: requestId };
	return { type: "ui_response", id: requestId, result };
}
