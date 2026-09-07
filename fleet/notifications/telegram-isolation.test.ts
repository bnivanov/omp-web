import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../registry";
import { DaemonConnector } from "../connector";
import { SpawnSupervisor } from "../supervisor";
import { HerdProjector } from "../projector";
import { TelegramDispatcher, type TelegramInboundMessage } from "./telegram";
import { TelegramAttachStore, EphemeralPromptCache } from "./telegram-attach";
import { TelegramInboundRouter } from "./telegram-inbound";
import { NotificationDispatcher } from "./dispatcher";
import { startFakeDaemon, waitFor, type FakeDaemon } from "../server.testkit";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "tg-iso-test-"));
}

describe("E-DOOR-02 & E-DOOR-03 Hermetic Tests", () => {
	let tmpDir: string;
	let statePath: string;
	let attachPath: string;
	let projADir: string;
	let projBDir: string;
	let registry: Registry;
	let projector: HerdProjector;
	let attachStore: TelegramAttachStore;
	let promptCache: EphemeralPromptCache;
	let sentMessages: Array<{ chat_id?: string; text: string }>;
	let fakeTelegram: TelegramDispatcher;
	let notifications: NotificationDispatcher;
	let router: TelegramInboundRouter;
	let connector: DaemonConnector;
	let supervisor: SpawnSupervisor;
	let fakeD1: FakeDaemon | undefined;
	let fakeD2: FakeDaemon | undefined;
	const ownerChatId = "12345678";

	beforeEach(async () => {
		tmpDir = makeTmpDir();
		statePath = join(tmpDir, "fleet-state.json");
		attachPath = join(tmpDir, "telegram-attach.json");

		projADir = join(tmpDir, "proj-a");
		projBDir = join(tmpDir, "proj-b");
		mkdirSync(join(projADir, ".git"), { recursive: true });
		mkdirSync(join(projBDir, ".git"), { recursive: true });

		registry = new Registry(statePath);
		await registry.load();

		await registry.addProject(projADir);
		await registry.addProject(projBDir);

		fakeD1 = startFakeDaemon("tok1", projADir);
		fakeD2 = startFakeDaemon("tok2", projBDir);

		registry.create({
			mode: "attached",
			status: "ready",
			name: "proj-a-main",
			project: "proj-a",
			projectId: "p1",
			cwd: projADir,
			endpoint: fakeD1.url,
			token: "tok1",
			labels: [],
		});

		registry.create({
			mode: "attached",
			status: "ready",
			name: "proj-b-main",
			project: "proj-b",
			projectId: "p2",
			cwd: projBDir,
			endpoint: fakeD2.url,
			token: "tok2",
			labels: [],
		});

		projector = new HerdProjector();
		attachStore = new TelegramAttachStore(attachPath);
		promptCache = new EphemeralPromptCache();

		sentMessages = [];
		const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.includes("sendMessage")) {
				sentMessages.push(JSON.parse(String(init?.body ?? "{}")));
			}
			return new Response(JSON.stringify({ ok: true, result: {} }));
		}) as unknown as typeof fetch;

		fakeTelegram = new TelegramDispatcher(
			{ botToken: "dummy-token", chatId: ownerChatId },
			fakeFetch,
		);

		notifications = new NotificationDispatcher({ telegram: { botToken: "dummy-token", chatId: ownerChatId } }, fakeFetch);
		connector = new DaemonConnector(registry);
		supervisor = new SpawnSupervisor(registry, connector, {
			templates: {},
			defaultTemplate: "default",
			workspaceDir: tmpDir,
		});

		router = new TelegramInboundRouter({
			registry,
			connector,
			supervisor,
			projector,
			dispatcher: fakeTelegram,
			attachStore,
			promptCache,
			notifications,
			ownerChatId,
		});
	});

	afterEach(() => {
		fakeD1?.close();
		fakeD2?.close();
		connector?.close();
		supervisor?.close();
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	test("E-DOOR-02: Isolation across project attaches", async () => {
		// 1. /use p1 then send TOKEN_A_UNIQUE
		await router.handleMessage({
			messageId: 101,
			chatId: ownerChatId,
			text: "/use p1",
			date: Math.floor(Date.now() / 1000),
		});

		sentMessages = [];
		await router.handleMessage({
			messageId: 102,
			chatId: ownerChatId,
			text: "TOKEN_A_UNIQUE",
			date: Math.floor(Date.now() / 1000),
		});

		await waitFor(() => sentMessages.length > 0, 5000, "turn A reply");
		expect(sentMessages[0].text).toContain("*proj-a* · `d1`");

		// 2. /use p2 then send TOKEN_B_UNIQUE
		await router.handleMessage({
			messageId: 103,
			chatId: ownerChatId,
			text: "/use p2",
			date: Math.floor(Date.now() / 1000),
		});

		sentMessages = [];
		await router.handleMessage({
			messageId: 104,
			chatId: ownerChatId,
			text: "TOKEN_B_UNIQUE",
			date: Math.floor(Date.now() / 1000),
		});

		await waitFor(() => sentMessages.length > 0, 5000, "turn B reply");
		expect(sentMessages[0].text).toContain("*proj-b* · `d2`");

		// 3. Verify seen calls on each daemon
		const callsA = fakeD1!.seen.calls as Array<{ type?: string; method?: string; args?: unknown[] }>;
		const callsB = fakeD2!.seen.calls as Array<{ type?: string; method?: string; args?: unknown[] }>;

		const textPromptsA = callsA
			.filter((c) => c.type === "call" && c.method === "prompt")
			.map((c) => String(c.args?.[0] ?? ""));
		const textPromptsB = callsB
			.filter((c) => c.type === "call" && c.method === "prompt")
			.map((c) => String(c.args?.[0] ?? ""));

		expect(textPromptsA).toContain("TOKEN_A_UNIQUE");
		expect(textPromptsA).not.toContain("TOKEN_B_UNIQUE");

		expect(textPromptsB).toContain("TOKEN_B_UNIQUE");
		expect(textPromptsB).not.toContain("TOKEN_A_UNIQUE");
	});

	test("E-DOOR-03: No pile & zero prompt leakage on commands or unattached drops", async () => {
		// 1. Attach A
		await router.handleMessage({
			messageId: 201,
			chatId: ownerChatId,
			text: "/use p1",
			date: Math.floor(Date.now() / 1000),
		});

		const callsBefore = fakeD1!.seen.calls.length;

		// 2. Meta commands: /herd, /projects, /where
		await router.handleMessage({
			messageId: 202,
			chatId: ownerChatId,
			text: "/herd",
			date: Math.floor(Date.now() / 1000),
		});
		await router.handleMessage({
			messageId: 203,
			chatId: ownerChatId,
			text: "/projects",
			date: Math.floor(Date.now() / 1000),
		});
		await router.handleMessage({
			messageId: 204,
			chatId: ownerChatId,
			text: "/where",
			date: Math.floor(Date.now() / 1000),
		});

		// Zero prompt calls to daemon
		expect(fakeD1!.seen.calls.length).toBe(callsBefore);

		// 3. Clear attach
		attachStore.clear(ownerChatId);

		// 4. Send stray lines without attaching
		await router.handleMessage({
			messageId: 205,
			chatId: ownerChatId,
			text: "stray 1",
			date: Math.floor(Date.now() / 1000),
		});
		await router.handleMessage({
			messageId: 206,
			chatId: ownerChatId,
			text: "stray 2",
			date: Math.floor(Date.now() / 1000),
		});

		// Neither daemon received any prompt calls
		const promptCallsA = (fakeD1!.seen.calls as Array<{ method?: string }>).filter((c) => c.method === "prompt");
		const promptCallsB = (fakeD2!.seen.calls as Array<{ method?: string }>).filter((c) => c.method === "prompt");
		expect(promptCallsA.length).toBe(0);
		expect(promptCallsB.length).toBe(0);
	});
});
