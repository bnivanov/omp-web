import { describe, expect, test } from "bun:test";
import { dialogNotifyBody, redactForNotify } from "./redact";
import { NotificationDispatcher } from "./dispatcher";
import { TelegramDispatcher } from "./telegram";

describe("redactForNotify", () => {
	test("truncates and strips bearer-like secrets", () => {
		expect(redactForNotify("a".repeat(250)).length).toBeLessThanOrEqual(200);
		expect(redactForNotify("token Bearer sk-abcdefghijklmnop leaked")).toContain("[redacted]");
	});

	test("dialog body uses title + message", () => {
		expect(dialogNotifyBody("confirm", { title: "Deploy?", message: "prod" })).toBe(
			"Deploy?: prod",
		);
	});
});

describe("TelegramDispatcher.handleUpdate", () => {
	test("extracts callback_query data", () => {
		const tg = new TelegramDispatcher(
			{ botToken: "t", chatId: "1" },
			(async () => new Response("{}")) as unknown as typeof fetch,
		);
		const cbs = tg.handleUpdate({
			callback_query: { id: "q1", data: "t3" },
		});
		expect(cbs).toEqual([{ callbackId: "t3", callbackQueryId: "q1" }]);
	});
});

describe("NotificationDispatcher", () => {
	test("confirm buttons remember epoch tokens", async () => {
		const sent: unknown[] = [];
		const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(JSON.stringify({ ok: true, result: {} }));
		}) as unknown as typeof fetch;
		const d = new NotificationDispatcher({ telegram: { botToken: "bot", chatId: "9" } }, fakeFetch);
		await d.onDialog({
			daemonId: "d1",
			name: "alpha",
			dialog: {
				requestId: "ui1",
				method: "confirm",
				params: { title: "ok?" },
				epochToken: "d1:1:ui1",
			},
		});
		expect(sent.length).toBe(1);
		const body = sent[0] as {
			reply_markup?: { inline_keyboard?: Array<Array<{ callback_data: string }>> };
		};
		const yes = body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
		expect(yes).toMatch(/^t\d+$/);
		expect(d.takeCallback(yes ?? "")?.epochToken).toBe("d1:1:ui1");
		expect(d.takeCallback(yes ?? "")).toBeUndefined();
	});
});
