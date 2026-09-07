/**
 * Herd snapshot, dialog reply, and pty control-plane routes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FleetServer } from "./server";
import {
	cleanupTempDirs,
	fleetPaths,
	pinSettingsInMemory,
	postJson,
	startFakeDaemon,
	startTestFleet,
	waitFor,
	type FakeDaemon,
} from "./server.testkit";
import type { RegistryEntry } from "./registry";

afterAll(cleanupTempDirs);
await pinSettingsInMemory();

describe("herd / dialog / pty control plane", () => {
	let server: FleetServer;
	let fake: FakeDaemon;
	let entry: RegistryEntry;

	beforeAll(async () => {
		const paths = fleetPaths();
		server = await startTestFleet(
			{ statePath: paths.statePath, configPath: paths.configPath },
			{},
			{ settings: { registry: async () => [] } },
		);
		fake = startFakeDaemon("tok-herd");
		const res = await postJson(server.port, "/ctl/add", {
			name: "herd-d",
			url: fake.url,
			token: "tok-herd",
			cwd: "/tmp/fake-proj",
		});
		expect(res.status).toBe(200);
		entry = (await res.json()) as RegistryEntry;
		await waitFor(() => server.registry.get(entry.daemonId)?.status === "ready", 5000, "ready");
	});

	afterAll(async () => {
		await server.close();
		fake.close();
	});

	test("GET /ctl/herd is token-free and lists the ready daemon", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/herd`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { daemons: Array<Record<string, unknown>> };
		expect(body.daemons.length).toBeGreaterThan(0);
		const row = body.daemons.find((d) => d.daemonId === entry.daemonId);
		expect(row).toBeDefined();
		expect(row?.name).toBe("herd-d");
		expect(JSON.stringify(body)).not.toMatch(/"token"/);
		expect(JSON.stringify(body)).not.toContain("tok-herd");
	});

	test("POST /ctl/dialog/reply expires an unknown epoch", async () => {
		const res = await postJson(server.port, "/ctl/dialog/reply", {
			epochToken: `${entry.daemonId}:1:ui99`,
			action: "accept",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "expired" });
	});

	test("POST /ctl/pty runs a command and DELETE removes it", async () => {
		const spawn = await postJson(server.port, "/ctl/pty", { command: "printf 'from-ctl\\n'" });
		expect(spawn.status).toBe(201);
		const created = (await spawn.json()) as { id: string };
		const listed = await fetch(`http://127.0.0.1:${server.port}/ctl/pty`);
		const body = (await listed.json()) as { workers: Array<{ id: string }> };
		expect(body.workers.some((w) => w.id === created.id)).toBe(true);
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/pty/${created.id}`, {
			method: "DELETE",
		});
		expect(del.status).toBe(200);
	});
});
