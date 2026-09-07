/**
 * Notification outbox: WebPush + Telegram, fed by the herd observer.
 * Callback ids are short (`tN`) because Telegram caps callback_data at 64 bytes.
 */

import type { PendingDialog } from "../projector";
import { TelegramDispatcher, type TelegramConfig } from "./telegram";
import {
	parseSubscription,
	WebPushDispatcher,
	type PushSubscriptionJSON,
	type VapidKeys,
} from "./webpush";

export interface NotificationConfig {
	vapid?: VapidKeys;
	telegram?: TelegramConfig;
}

export interface DialogNotifyEvent {
	daemonId: string;
	name: string;
	dialog: PendingDialog;
}

export interface TurnEndNotifyEvent {
	daemonId: string;
	name: string;
	preview: string;
}

export interface CallbackBinding {
	epochToken: string;
	action: string;
	result?: unknown;
}

interface CallbackRoute {
	binding: CallbackBinding;
	at: number;
}

const CALLBACK_TTL_MS = 30 * 60_000;

export class NotificationDispatcher {
	readonly webpush: WebPushDispatcher | null;
	readonly telegram: TelegramDispatcher | null;
	readonly #callbacks = new Map<string, CallbackRoute>();
	#nextCb = 1;
	onTelegramReply?: (binding: CallbackBinding) => void;

	constructor(cfg: NotificationConfig, fetchImpl: typeof fetch = fetch) {
		this.webpush = cfg.vapid ? new WebPushDispatcher(cfg.vapid, fetchImpl) : null;
		this.telegram = cfg.telegram ? new TelegramDispatcher(cfg.telegram, fetchImpl) : null;
		if (this.telegram) {
			this.telegram.onCallback = (cb) => {
				const binding = this.takeCallback(cb.callbackId);
				if (binding) this.onTelegramReply?.(binding);
				void this.telegram?.answerCallback(cb.callbackQueryId);
			};
		}
	}

	start(): void {
		this.telegram?.start();
	}

	stop(): void {
		this.telegram?.stop();
	}

	async onDialog(ev: DialogNotifyEvent): Promise<void> {
		const buttons = this.#dialogButtons(ev.dialog);
		await Promise.all([
			this.webpush?.notifyDialog({
				daemonId: ev.daemonId,
				name: ev.name,
				method: ev.dialog.method,
				params: ev.dialog.params,
				epochToken: ev.dialog.epochToken,
			}),
			this.telegram?.notifyDialog({
				daemonId: ev.daemonId,
				name: ev.name,
				method: ev.dialog.method,
				params: ev.dialog.params,
				buttons,
			}),
		]);
	}

	async onTurnEnd(ev: TurnEndNotifyEvent): Promise<void> {
		await Promise.all([
			this.webpush?.notifyTurnEnd(ev),
			this.telegram?.notifyTurnEnd({ name: ev.name, preview: ev.preview }),
		]);
	}

	subscribePush(body: Record<string, unknown>): PushSubscriptionJSON | null {
		if (!this.webpush) return null;
		const sub = parseSubscription(body);
		if (!sub) return null;
		this.webpush.subscribe(sub);
		return sub;
	}

	unsubscribePush(endpoint: string): void {
		this.webpush?.unsubscribe(endpoint);
	}

	takeCallback(id: string): CallbackBinding | undefined {
		this.#gc();
		const row = this.#callbacks.get(id);
		if (!row) return undefined;
		this.#callbacks.delete(id);
		return row.binding;
	}

	#remember(binding: CallbackBinding): string {
		this.#gc();
		const id = `t${this.#nextCb++}`;
		this.#callbacks.set(id, { binding, at: Date.now() });
		return id;
	}

	#dialogButtons(dialog: PendingDialog): Array<{ text: string; callbackId: string }> {
		if (dialog.method === "confirm") {
			return [
				{
					text: "Yes",
					callbackId: this.#remember({ epochToken: dialog.epochToken, action: "accept" }),
				},
				{
					text: "No",
					callbackId: this.#remember({ epochToken: dialog.epochToken, action: "reject" }),
				},
			];
		}
		if (dialog.method === "select" && typeof dialog.params === "object" && dialog.params !== null) {
			const rec = dialog.params as Record<string, unknown>;
			const options = rec.options;
			if (!Array.isArray(options)) return [];
			const buttons: Array<{ text: string; callbackId: string }> = [];
			for (const opt of options.slice(0, 8)) {
				if (typeof opt !== "object" || opt === null) continue;
				const o = opt as Record<string, unknown>;
				const value =
					typeof o.value === "string" ? o.value : typeof o.id === "string" ? o.id : null;
				const label = typeof o.label === "string" ? o.label : value;
				if (value === null || label === null) continue;
				buttons.push({
					text: label,
					callbackId: this.#remember({
						epochToken: dialog.epochToken,
						action: "select",
						result: value,
					}),
				});
			}
			return buttons;
		}
		return [];
	}

	#gc(): void {
		const now = Date.now();
		for (const [id, row] of this.#callbacks) {
			if (now - row.at > CALLBACK_TTL_MS) this.#callbacks.delete(id);
		}
	}
}
