/**
 * Telegram attach state & ephemeral prompt cache (SLICE v0).
 *
 * Persists chat-to-daemon routing with a 4h idle expiry (from lastTurnAt).
 * Holds untagged/stale prompts in an ephemeral 90s cache until a project
 * button is tapped or stale execution is confirmed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface TelegramAttachState {
	chatId: string;
	projectId: string;
	daemonId: string;
	sessionFile?: string;
	attachedAt: number;
	lastTurnAt: number;
}

export const DEFAULT_ATTACH_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
export const DEFAULT_PROMPT_CACHE_TTL_MS = 90 * 1000; // 90 seconds

export interface CachedPrompt {
	promptId: string;
	chatId: string;
	text: string;
	originalDate?: number;
	storedAt: number;
}

/**
 * Ephemeral prompt cache for holding unattached / stale prompts.
 * Prompts expire after ttlMs (default 90s) unless claimed.
 */
export class EphemeralPromptCache {
	readonly #ttlMs: number;
	readonly #cache = new Map<string, CachedPrompt>();

	constructor(ttlMs = DEFAULT_PROMPT_CACHE_TTL_MS) {
		this.#ttlMs = ttlMs;
	}

	put(text: string, chatId: string, originalDate?: number): string {
		this.gc();
		const promptId = `p_${randomBytes(6).toString("hex")}`;
		this.#cache.set(promptId, {
			promptId,
			chatId,
			text,
			originalDate,
			storedAt: Date.now(),
		});
		return promptId;
	}

	get(promptId: string): CachedPrompt | undefined {
		const item = this.#cache.get(promptId);
		if (!item) return undefined;
		if (Date.now() - item.storedAt > this.#ttlMs) {
			this.#cache.delete(promptId);
			return undefined;
		}
		return item;
	}

	take(promptId: string): CachedPrompt | undefined {
		const item = this.get(promptId);
		if (item) {
			this.#cache.delete(promptId);
		}
		return item;
	}

	gc(): void {
		const now = Date.now();
		for (const [id, item] of this.#cache.entries()) {
			if (now - item.storedAt > this.#ttlMs) {
				this.#cache.delete(id);
			}
		}
	}

	clear(): void {
		this.#cache.clear();
	}
}

/**
 * File-backed or in-memory attach state store.
 */
export class TelegramAttachStore {
	readonly #storagePath?: string;
	readonly #ttlMs: number;
	readonly #states = new Map<string, TelegramAttachState>();

	constructor(storagePath?: string, ttlMs = DEFAULT_ATTACH_TTL_MS) {
		this.#storagePath = storagePath;
		this.#ttlMs = ttlMs;
		this.#load();
	}

	get(chatId: string): TelegramAttachState | null {
		const state = this.#states.get(chatId);
		if (!state) return null;
		const now = Date.now();
		if (now - state.lastTurnAt > this.#ttlMs) {
			this.#states.delete(chatId);
			this.#save();
			return null;
		}
		return state;
	}

	set(state: TelegramAttachState): void {
		this.#states.set(state.chatId, { ...state });
		this.#save();
	}

	touch(chatId: string, now = Date.now()): void {
		const state = this.get(chatId);
		if (!state) return;
		state.lastTurnAt = now;
		this.#save();
	}

	updateSessionFile(chatId: string, sessionFile: string): void {
		const state = this.get(chatId);
		if (!state) return;
		state.sessionFile = sessionFile;
		state.lastTurnAt = Date.now();
		this.#save();
	}

	clear(chatId: string): void {
		if (this.#states.delete(chatId)) {
			this.#save();
		}
	}

	all(): TelegramAttachState[] {
		const now = Date.now();
		const result: TelegramAttachState[] = [];
		let changed = false;
		for (const [chatId, state] of this.#states.entries()) {
			if (now - state.lastTurnAt > this.#ttlMs) {
				this.#states.delete(chatId);
				changed = true;
			} else {
				result.push(state);
			}
		}
		if (changed) this.#save();
		return result;
	}

	#load(): void {
		if (!this.#storagePath || !existsSync(this.#storagePath)) return;
		try {
			const raw = readFileSync(this.#storagePath, "utf-8");
			const parsed = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null) {
				const now = Date.now();
				for (const [chatId, val] of Object.entries(parsed as Record<string, unknown>)) {
					if (typeof val === "object" && val !== null) {
						const rec = val as Record<string, unknown>;
						if (
							typeof rec.projectId === "string" &&
							typeof rec.daemonId === "string" &&
							typeof rec.attachedAt === "number" &&
							typeof rec.lastTurnAt === "number"
						) {
							if (now - rec.lastTurnAt <= this.#ttlMs) {
								this.#states.set(chatId, {
									chatId,
									projectId: rec.projectId,
									daemonId: rec.daemonId,
									sessionFile: typeof rec.sessionFile === "string" ? rec.sessionFile : undefined,
									attachedAt: rec.attachedAt,
									lastTurnAt: rec.lastTurnAt,
								});
							}
						}
					}
				}
			}
		} catch {
			// Malformed state falls back to empty.
		}
	}

	#save(): void {
		if (!this.#storagePath) return;
		try {
			mkdirSync(dirname(this.#storagePath), { recursive: true });
			const obj: Record<string, TelegramAttachState> = {};
			for (const [chatId, state] of this.#states.entries()) {
				obj[chatId] = state;
			}
			const tmp = `${this.#storagePath}.tmp.${Date.now()}`;
			writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
			writeFileSync(this.#storagePath, JSON.stringify(obj, null, 2), "utf-8");
		} catch {
			// Best-effort write.
		}
	}
}
