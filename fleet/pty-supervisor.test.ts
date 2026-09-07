import { describe, expect, test } from "bun:test";
import { PtySupervisor } from "./pty-supervisor";

describe("PtySupervisor", () => {
	test("spawns a command, captures stdout, then exits", async () => {
		// Real child process; fake timers cannot drive Bun.spawn completion.
		const pty = new PtySupervisor();
		try {
			const snap = pty.spawn({ command: "printf 'hello-pty\\n'" });
			expect(snap.id).toMatch(/^pty\d+$/);
			expect(snap.status).toBe("running");
			const deadline = Date.now() + 3000;
			let live = pty.get(snap.id);
			while (live && live.status === "running" && Date.now() < deadline) {
				await Bun.sleep(20);
				live = pty.get(snap.id);
			}
			expect(live?.status).toBe("exited");
			expect(live?.output).toContain("hello-pty");
			expect(live?.exitCode).toBe(0);
		} finally {
			pty.close();
		}
	});

	test("kill marks the worker killed", async () => {
		const pty = new PtySupervisor();
		try {
			const snap = pty.spawn({ command: "sleep 30" });
			expect(pty.kill(snap.id)).toBe(true);
			const deadline = Date.now() + 3000;
			let live = pty.get(snap.id);
			while (live && live.status === "running" && Date.now() < deadline) {
				await Bun.sleep(20);
				live = pty.get(snap.id);
			}
			expect(live?.status).toBe("killed");
			expect(pty.remove(snap.id)).toBe(true);
			expect(pty.get(snap.id)).toBeUndefined();
		} finally {
			pty.close();
		}
	});

	test("rejects an empty command", () => {
		const pty = new PtySupervisor();
		expect(() => pty.spawn({ command: "" })).toThrow(/empty/);
		pty.close();
	});
});
