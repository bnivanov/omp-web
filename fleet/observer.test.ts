import { describe, expect, test } from "bun:test";
import { agentEndPreview, dialogResponseCommand } from "./observer";

describe("agentEndPreview", () => {
	test("only agent_end events produce a preview", () => {
		expect(agentEndPreview({ type: "ready", readyAt: 1 })).toBeUndefined();
		expect(
			agentEndPreview({ type: "event", event: { type: "tool_execution_start" } as never }),
		).toBeUndefined();
		expect(agentEndPreview({ type: "event", event: { type: "agent_end" } as never })).toBe(
			"turn complete",
		);
	});
});

describe("dialogResponseCommand", () => {
	test("omits result on cancel", () => {
		expect(dialogResponseCommand("ui1", undefined)).toEqual({ type: "ui_response", id: "ui1" });
		expect(dialogResponseCommand("ui1", true)).toEqual({
			type: "ui_response",
			id: "ui1",
			result: true,
		});
	});
});
