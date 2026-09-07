/**
 * Telegram Bot API alerts with inline-keyboard replies.
 * Callback routing uses short ids (Telegram's 64-byte callback_data cap).
 */

import { dialogNotifyBody, redactForNotify } from "./redact";

export interface TelegramConfig {
	botToken: string;
	chatId: string;
	/** Optional shared secret checked as X-Telegram-Bot-Api-Secret-Token. */
	webhookSecret?: string;
	/** Long-poll getUpdates (single-operator; skip when using a webhook). */
	poll?: boolean;
}

export interface TelegramSendInput {
	chatId?: string;
	title?: string;
	body: string;
	buttons?: Array<{ text: string; callbackId: string }> | Array<Array<{ text: string; callbackId: string }>>;
	parseMode?: "Markdown" | "MarkdownV2" | "HTML";
}

export interface TelegramCallback {
	callbackId: string;
	callbackQueryId: string;
	chatId?: string;
	messageId?: number;
	messageDate?: number;
}

export interface TelegramInboundMessage {
	messageId: number;
	chatId: string;
	text: string;
	date: number; // Unix timestamp in seconds
	from?: { id: number; firstName?: string; username?: string };
}

const API = "https://api.telegram.org";

export class TelegramDispatcher {
	readonly #cfg: TelegramConfig;
	readonly #fetch: typeof fetch;
	#offset = 0;
	#pollTimer: ReturnType<typeof setTimeout> | null = null;
	#closed = false;
	onCallback?: (cb: TelegramCallback) => void | Promise<void>;
	onMessage?: (msg: TelegramInboundMessage) => void | Promise<void>;
	constructor(cfg: TelegramConfig, fetchImpl: typeof fetch = fetch) {
		this.#cfg = cfg;
		this.#fetch = fetchImpl;
	}

	start(): void {
		if (!this.#cfg.poll) return;
		void this.#pollLoop();
	}

	stop(): void {
		this.#closed = true;
		if (this.#pollTimer) {
			clearTimeout(this.#pollTimer);
			this.#pollTimer = null;
		}
	}

	async notifyDialog(input: {
		daemonId: string;
		name: string;
		method: string;
		params: unknown;
		buttons: Array<{ text: string; callbackId: string }>;
	}): Promise<void> {
		const title = redactForNotify(`${input.name} needs you`);
		const body = dialogNotifyBody(input.method, input.params);
		await this.send({ title, body, buttons: input.buttons });
	}

	async notifyTurnEnd(input: { name: string; preview: string }): Promise<void> {
		await this.send({
			title: redactForNotify(`${input.name} finished`),
			body: redactForNotify(input.preview),
		});
	}

	async send(input: TelegramSendInput): Promise<void> {
		const text = input.title ? `*${escapeMd(input.title)}*\n${escapeMd(input.body)}` : input.body;
		let inline_keyboard: Array<Array<{ text: string; callback_data: string }>> | undefined;
		if (input.buttons && input.buttons.length > 0) {
			if (Array.isArray(input.buttons[0])) {
				inline_keyboard = (input.buttons as Array<Array<{ text: string; callbackId: string }>>).map((row) =>
					row.map((b) => ({ text: b.text, callback_data: b.callbackId })),
				);
			} else {
				inline_keyboard = [
					(input.buttons as Array<{ text: string; callbackId: string }>).map((b) => ({
						text: b.text,
						callback_data: b.callbackId,
					})),
				];
			}
		}
		const reply_markup = inline_keyboard ? { inline_keyboard } : undefined;
		await this.#api("sendMessage", {
			chat_id: input.chatId ?? this.#cfg.chatId,
			text,
			parse_mode: input.parseMode ?? (input.title ? "Markdown" : undefined),
			reply_markup,
		});
	}

	async sendChatAction(chatId?: string, action = "typing"): Promise<void> {
		try {
			await this.#api("sendChatAction", {
				chat_id: chatId ?? this.#cfg.chatId,
				action,
			});
		} catch {
			// Best-effort typing heartbeat
		}
	}

	async sendDocument(input: {
		chatId?: string;
		filename: string;
		content: string | Uint8Array;
		caption?: string;
	}): Promise<void> {
		const form = new FormData();
		form.append("chat_id", input.chatId ?? this.#cfg.chatId);
		if (input.caption) form.append("caption", input.caption);
		const blobPart: BlobPart = typeof input.content === "string" ? input.content : (input.content as unknown as BlobPart);
		const blob = new Blob([blobPart], { type: "text/markdown; charset=utf-8" });
		form.append("document", blob, input.filename);

		const res = await this.#fetch(`${API}/bot${this.#cfg.botToken}/sendDocument`, {
			method: "POST",
			body: form,
		});
		if (!res.ok) {
			throw new Error(`telegram sendDocument HTTP ${res.status}`);
		}
	}

	async answerCallback(callbackQueryId: string, text = "ok"): Promise<void> {
		await this.#api("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
	}

	/** Webhook / poll body from Telegram. Returns handled callbacks and passes messages to onMessage. */
	handleUpdate(raw: unknown): TelegramCallback[] {
		if (typeof raw !== "object" || raw === null) return [];
		const rec = raw as Record<string, unknown>;
		const callbacks: TelegramCallback[] = [];

		if (typeof rec.callback_query === "object" && rec.callback_query !== null) {
			const query = rec.callback_query as Record<string, unknown>;
			const id = typeof query.id === "string" ? query.id : "";
			const data = typeof query.data === "string" ? query.data : "";
			let chatId: string | undefined;
			let messageId: number | undefined;
			let messageDate: number | undefined;
			if (typeof query.message === "object" && query.message !== null) {
				const msg = query.message as Record<string, unknown>;
				if (typeof msg.message_id === "number") messageId = msg.message_id;
				if (typeof msg.date === "number") messageDate = msg.date;
				if (typeof msg.chat === "object" && msg.chat !== null) {
					const chat = msg.chat as Record<string, unknown>;
					if (chat.id !== undefined) chatId = String(chat.id);
				}
			}
			if (id.length > 0 && data.length > 0) {
				const cb: TelegramCallback = {
					callbackId: data,
					callbackQueryId: id,
					chatId,
					messageId,
					messageDate,
				};
				callbacks.push(cb);
				void this.onCallback?.(cb);
			}
		}

		if (typeof rec.message === "object" && rec.message !== null) {
			const msg = rec.message as Record<string, unknown>;
			const messageId = typeof msg.message_id === "number" ? msg.message_id : 0;
			const date = typeof msg.date === "number" ? msg.date : Math.floor(Date.now() / 1000);
			const text = typeof msg.text === "string" ? msg.text : "";
			let chatId = "";
			if (typeof msg.chat === "object" && msg.chat !== null) {
				const chat = msg.chat as Record<string, unknown>;
				if (chat.id !== undefined) chatId = String(chat.id);
			}
			let from: { id: number; firstName?: string; username?: string } | undefined;
			if (typeof msg.from === "object" && msg.from !== null) {
				const f = msg.from as Record<string, unknown>;
				if (typeof f.id === "number") {
					from = {
						id: f.id,
						firstName: typeof f.first_name === "string" ? f.first_name : undefined,
						username: typeof f.username === "string" ? f.username : undefined,
					};
				}
			}
			if (chatId.length > 0 && text.length > 0) {
				const inbound: TelegramInboundMessage = { messageId, chatId, text, date, from };
				void this.onMessage?.(inbound);
			}
		}

		return callbacks;
	}
	webhookAuthorized(headers: Headers): boolean {
		const secret = this.#cfg.webhookSecret;
		if (secret === undefined || secret.length === 0) return true;
		return headers.get("x-telegram-bot-api-secret-token") === secret;
	}

	async #pollLoop(): Promise<void> {
		while (!this.#closed) {
			try {
				const updates = await this.#api("getUpdates", {
					offset: this.#offset,
					timeout: 25,
					allowed_updates: ["message", "callback_query"],
				});
				if (Array.isArray(updates)) {
					for (const update of updates) {
						if (typeof update !== "object" || update === null) continue;
						const rec = update as Record<string, unknown>;
						if (typeof rec.update_id === "number") this.#offset = rec.update_id + 1;
						this.handleUpdate(update);
					}
				}
			} catch {
				// Back off on transport errors; the next tick retries.
			}
			if (this.#closed) return;
			await new Promise<void>((resolve) => {
				this.#pollTimer = setTimeout(resolve, 500);
			});
		}
	}

	async #api(method: string, body: Record<string, unknown>): Promise<unknown> {
		const res = await this.#fetch(`${API}/bot${this.#cfg.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`telegram ${method} HTTP ${res.status}`);
		}
		const json: unknown = await res.json();
		if (typeof json !== "object" || json === null) return undefined;
		const rec = json as Record<string, unknown>;
		return rec.result;
	}
}

function escapeMd(text: string): string {
	return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
