/**
 * Epoch-scoped dialog resolution: validate method payloads, remember
 * idempotency keys, and map a /ctl/dialog/reply body onto ui_response.
 */

import type { PendingDialog } from "./projector";
import { parseEpochToken } from "./projector";

export type DialogReplyStatus = "applied" | "already_applied" | "expired";

export interface DialogReplyBody {
	epochToken: string;
	action?: string;
	result?: unknown;
	idempotencyKey?: string;
}

export interface DialogReplyOk {
	status: DialogReplyStatus;
	daemonId?: string;
	requestId?: string;
	result?: unknown;
}

export interface DialogReplyErr {
	error: string;
}

const DIALOG_METHODS: Record<string, true> = {
	confirm: true,
	select: true,
	input: true,
	editor: true,
	askDialog: true,
};

const IDEMPOTENCY_CAP = 256;
const IDEMPOTENCY_TTL_MS = 10 * 60_000;

export class DialogIdempotency {
	readonly #seen = new Map<string, number>();

	/** Returns true when this key is new (and is now recorded). */
	claim(key: string, now = Date.now()): boolean {
		this.#gc(now);
		if (this.#seen.has(key)) return false;
		this.#seen.set(key, now);
		if (this.#seen.size > IDEMPOTENCY_CAP) {
			const oldest = this.#seen.keys().next().value;
			if (oldest !== undefined) this.#seen.delete(oldest);
		}
		return true;
	}

	#gc(now: number): void {
		for (const [key, at] of this.#seen) {
			if (now - at > IDEMPOTENCY_TTL_MS) this.#seen.delete(key);
		}
	}
}

export function parseDialogReply(body: Record<string, unknown>): DialogReplyBody | DialogReplyErr {
	const epochToken = body.epochToken;
	if (typeof epochToken !== "string" || epochToken.length === 0) {
		return { error: "missing field: epochToken" };
	}
	if (parseEpochToken(epochToken) === null) {
		return { error: "invalid field: epochToken" };
	}
	const action = body.action;
	if (action !== undefined && typeof action !== "string") {
		return { error: "invalid field: action" };
	}
	const idempotencyKey = body.idempotencyKey;
	if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
		return { error: "invalid field: idempotencyKey" };
	}
	return {
		epochToken,
		action: typeof action === "string" ? action : undefined,
		result: body.result,
		idempotencyKey,
	};
}

/**
 * Map action/result onto the value the daemon's ExtensionUIContext expects.
 * `undefined` is a genuine cancel (ui_response with no result).
 */
export function resolveDialogResult(
	dialog: PendingDialog,
	action: string | undefined,
	result: unknown,
): { ok: true; result: unknown } | DialogReplyErr {
	if (!DIALOG_METHODS[dialog.method]) {
		return { error: `unsupported dialog method: ${dialog.method}` };
	}
	if (action === "cancel" || action === "dismiss") {
		return { ok: true, result: undefined };
	}
	switch (dialog.method) {
		case "confirm": {
			if (action === "accept" || action === "yes" || result === true)
				return { ok: true, result: true };
			if (action === "reject" || action === "no" || result === false)
				return { ok: true, result: false };
			return { error: "confirm expects action accept|reject or result boolean" };
		}
		case "select": {
			if (typeof result !== "string" || result.length === 0) {
				return { error: "select expects result string" };
			}
			return { ok: true, result };
		}
		case "input":
		case "editor": {
			if (typeof result !== "string") {
				return { error: `${dialog.method} expects result string` };
			}
			return { ok: true, result };
		}
		case "askDialog": {
			if (result === undefined || typeof result !== "object" || result === null) {
				return { error: "askDialog expects result object" };
			}
			return { ok: true, result };
		}
		default:
			return { error: `unsupported dialog method: ${dialog.method}` };
	}
}
