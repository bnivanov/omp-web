import { describe, expect, test } from "bun:test";
import { HerdProjector, makeEpochToken, parseEpochToken } from "./projector";
import type { RegistryEntry } from "./registry";

function entry(id: string, status: RegistryEntry["status"] = "ready"): RegistryEntry {
	return {
		daemonId: id,
		name: id,
		mode: "spawned",
		status,
		project: "p",
		cwd: "/tmp/p",
		labels: [],
		registeredAt: 1,
	};
}

describe("epoch tokens", () => {
	test("round-trip and reject junk", () => {
		const tok = makeEpochToken("d1", 3, "ui2");
		expect(parseEpochToken(tok)).toEqual({ daemonId: "d1", bootEpoch: 3, requestId: "ui2" });
		expect(parseEpochToken("nope")).toBeNull();
		expect(parseEpochToken("d1:0:ui1")).toBeNull();
	});
});

describe("HerdProjector", () => {
	test("ready bump expires prior dialogs; ui_request blocks", () => {
		const p = new HerdProjector();
		expect(p.markReady("d1")).toBe(1);
		p.applyFrame("d1", {
			type: "ui_request",
			id: "ui1",
			method: "confirm",
			params: { title: "go?" },
		});
		const snap = p.snapshot([entry("d1")]);
		expect(snap.daemons[0]?.status).toBe("blocked_ui");
		expect(snap.daemons[0]?.pendingDialogs).toHaveLength(1);
		const token = snap.daemons[0]!.pendingDialogs[0]!.epochToken;
		expect(p.getDialog(token)?.method).toBe("confirm");
		expect(p.markReady("d1")).toBe(2);
		expect(p.getDialog(token)).toBeUndefined();
	});

	test("streaming / error / offline mapping; snapshot never carries token keys", () => {
		const p = new HerdProjector();
		p.markReady("d1");
		p.applyFrame("d1", {
			type: "state",
			state: { isStreaming: true } as never,
		});
		expect(p.snapshot([entry("d1")]).daemons[0]?.status).toBe("streaming");
		expect(p.snapshot([entry("d2", "error")]).daemons[0]?.status).toBe("error");
		expect(p.snapshot([entry("d3", "asleep")]).daemons[0]?.status).toBe("offline");
		const json = JSON.stringify(p.snapshot([entry("d1")]));
		expect(json).not.toContain('"token"');
		expect(json).not.toContain("endpoint");
	});

	test("ui_request_end clears the pending dialog", () => {
		const p = new HerdProjector();
		p.markReady("d1");
		p.applyFrame("d1", { type: "ui_request", id: "ui1", method: "input", params: { title: "x" } });
		p.applyFrame("d1", { type: "ui_request_end", id: "ui1" });
		expect(p.snapshot([entry("d1")]).daemons[0]?.pendingDialogs).toHaveLength(0);
		expect(p.snapshot([entry("d1")]).daemons[0]?.status).toBe("idle");
	});
});
