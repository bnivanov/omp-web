import { describe, expect, test } from "bun:test";
import { DialogIdempotency, parseDialogReply, resolveDialogResult } from "./dialog-reply";
import type { PendingDialog } from "./projector";

const confirm: PendingDialog = {
	requestId: "ui1",
	method: "confirm",
	params: { title: "ok?" },
	epochToken: "d1:1:ui1",
};

describe("parseDialogReply", () => {
	test("requires a well-formed epochToken", () => {
		expect(parseDialogReply({})).toEqual({ error: "missing field: epochToken" });
		expect(parseDialogReply({ epochToken: "bad" })).toEqual({ error: "invalid field: epochToken" });
		const ok = parseDialogReply({ epochToken: "d1:1:ui1", action: "accept" });
		expect("epochToken" in ok && ok.epochToken).toBe("d1:1:ui1");
	});
});

describe("resolveDialogResult", () => {
	test("confirm maps accept/reject and booleans", () => {
		expect(resolveDialogResult(confirm, "accept", undefined)).toEqual({ ok: true, result: true });
		expect(resolveDialogResult(confirm, "reject", undefined)).toEqual({ ok: true, result: false });
		expect(resolveDialogResult(confirm, undefined, true)).toEqual({ ok: true, result: true });
		expect(resolveDialogResult(confirm, "cancel", undefined)).toEqual({
			ok: true,
			result: undefined,
		});
		expect(resolveDialogResult(confirm, undefined, "x")).toHaveProperty("error");
	});

	test("select/input/askDialog type-check the payload", () => {
		const select: PendingDialog = { ...confirm, method: "select" };
		expect(resolveDialogResult(select, undefined, "opt-a")).toEqual({ ok: true, result: "opt-a" });
		expect(resolveDialogResult(select, undefined, 1)).toHaveProperty("error");
		const input: PendingDialog = { ...confirm, method: "input" };
		expect(resolveDialogResult(input, undefined, "hi")).toEqual({ ok: true, result: "hi" });
		const ask: PendingDialog = { ...confirm, method: "askDialog" };
		expect(resolveDialogResult(ask, undefined, { answers: [] })).toEqual({
			ok: true,
			result: { answers: [] },
		});
	});
});

describe("DialogIdempotency", () => {
	test("second claim of the same key is rejected", () => {
		const box = new DialogIdempotency();
		expect(box.claim("k")).toBe(true);
		expect(box.claim("k")).toBe(false);
	});
});
