/**
 * Fleet configuration: spawn templates and the default template, loaded
 * from `~/.omp-web/config.json`.
 *
 * Resolution order: an explicit `path` argument wins, then env
 * `OMP_FLEET_CONFIG`, then the default location. A missing file yields
 * defaults; the file is shallow-merged over the defaults and unknown fields
 * are tolerated. `OMP_FLEET_SPAWN_HOOK` overrides the config file's
 * `spawnHook`; `OMP_FLEET_LOCAL_TEMPLATE` replaces the `local` template's
 * command outright (dev runners point it at the source entry when the
 * production binary isn't built). `workspaceDir` (root for managed
 * worktrees) resolves flag `--workspace-dir` > env `OMP_FLEET_WORKSPACE_DIR`
 * > config-file `workspaceDir` key > `~/.omp-web/workspaces`. A leading `~` is
 * expanded to `os.homedir()` in paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SpawnTemplate {
	/** Command template; `{key}` placeholders are filled by spawn-parse.ts's fillTemplate. */
	command: string;
	/** Template-declared reachable host (R6b): used when no wrapper endpoint/advertise is seen. */
	host?: string;
}

export interface FleetNotificationConfig {
	vapid?: { publicKey: string; privateKey: string; subject: string };
	telegram?: { botToken: string; chatId: string; webhookSecret?: string; poll?: boolean };
}

export interface FleetConfig {
	templates: Record<string, SpawnTemplate>;
	defaultTemplate: string;
	/**
	 * Per-project template override (project basename → template name),
	 * consulted by supervisor.spawn when no explicit template is given.
	 */
	projectTemplates?: Record<string, string>;
	/** Env `OMP_FLEET_SPAWN_HOOK` wins over the config file value. */
	spawnHook?: string;
	/**
	 * Root for managed worktrees (created lazily on first worktree, never at
	 * boot). Flag `--workspace-dir` > env `OMP_FLEET_WORKSPACE_DIR` >
	 * config-file `workspaceDir` key > `~/.omp-web/workspaces` (~ expanded).
	 */
	workspaceDir: string;
	/** Bind address. Default 127.0.0.1. Flag/env win over the file. */
	host?: string;
	/** Fleet operator bearer for off-loopback callers. Never serialized to roster. */
	token?: string;
	/** Trust Tailscale-User-Login from Tailscale IP space. */
	tailscaleAuth?: boolean;
	notifications?: FleetNotificationConfig;
}

/**
 * Default local spawn template. `{labels}` expands to repeated `--label k=v`
 * args (empty string when no labels); `{resume}` expands to
 * `--resume <lastSessionFile>` when the daemon has one (empty otherwise);
 * the other placeholders are filled from the registry entry at spawn time.
 */
export const DEFAULT_LOCAL_TEMPLATE: SpawnTemplate = {
	command: "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}",
};

/** Default managed-worktree root under the consolidated home data dir. */
export function defaultWorkspaceDir(): string {
	return expandTilde("~/.omp-web/workspaces");
}

function defaultConfig(): FleetConfig {
	return {
		templates: { local: { ...DEFAULT_LOCAL_TEMPLATE } },
		defaultTemplate: "local",
		workspaceDir: defaultWorkspaceDir(),
		host: "127.0.0.1",
		tailscaleAuth: false,
	};
}

/** Expand a leading `~` / `~/` to os.homedir(); other paths pass through. */
export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export async function loadConfig(
	path?: string,
	opts?: { workspaceDir?: string; host?: string; token?: string; tailscaleAuth?: boolean },
): Promise<FleetConfig> {
	const file = resolveConfigPath(path);
	let config: FleetConfig;
	if (!existsSync(file)) {
		config = defaultConfig();
	} else {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// Unreadable or corrupt config falls back to defaults.
			raw = undefined;
		}
		config = raw === undefined ? defaultConfig() : mergeConfig(raw);
	}
	// Env wins over every file source (scripts/dev.ts fleet mode sets this so
	// sidebar spawns run the source entry, not the unbuilt production binary).
	const localCommand = process.env.OMP_FLEET_LOCAL_TEMPLATE;
	if (localCommand !== undefined && localCommand !== "") {
		config.templates = { ...config.templates, local: { command: localCommand } };
	}
	// The explicit CLI flag (`--workspace-dir`) wins over env and the file.
	const flagDir = opts?.workspaceDir;
	if (flagDir !== undefined && flagDir !== "") {
		config.workspaceDir = expandTilde(flagDir);
	}
	const envHost = process.env.OMP_FLEET_HOST;
	if (opts?.host !== undefined && opts.host !== "") config.host = opts.host;
	else if (envHost !== undefined && envHost !== "") config.host = envHost;
	const envToken = process.env.OMP_FLEET_TOKEN;
	if (opts?.token !== undefined && opts.token !== "") config.token = opts.token;
	else if (envToken !== undefined && envToken !== "") config.token = envToken;
	const envTs = process.env.OMP_FLEET_TAILSCALE_AUTH;
	if (opts?.tailscaleAuth !== undefined) config.tailscaleAuth = opts.tailscaleAuth;
	else if (envTs === "1" || envTs === "true") config.tailscaleAuth = true;
	applyNotificationEnv(config);
	return config;
}

/** Resolve the config path the loader will read (explicit > env > default). */
export function resolveConfigPath(explicit?: string): string {
	if (explicit !== undefined) return expandTilde(explicit);
	const env = process.env.OMP_FLEET_CONFIG;
	if (env !== undefined && env !== "") return expandTilde(env);
	return join(homedir(), ".omp-web", "config.json");
}

/** Shallow-merge the parsed file over the defaults; malformed/unknown fields fall back. */
function mergeConfig(raw: unknown): FleetConfig {
	const config = defaultConfig();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return config;
	const file = raw as Record<string, unknown>;
	if (isTemplateMap(file.templates)) {
		config.templates = file.templates;
	}
	if (typeof file.defaultTemplate === "string") {
		config.defaultTemplate = file.defaultTemplate;
	}
	if (isProjectTemplateMap(file.projectTemplates)) {
		config.projectTemplates = file.projectTemplates;
	}
	const hook = process.env.OMP_FLEET_SPAWN_HOOK;
	if (hook !== undefined && hook !== "") {
		config.spawnHook = hook;
	} else if (typeof file.spawnHook === "string") {
		config.spawnHook = expandTilde(file.spawnHook);
	}
	const workspaceDir = process.env.OMP_FLEET_WORKSPACE_DIR;
	if (workspaceDir !== undefined && workspaceDir !== "") {
		config.workspaceDir = expandTilde(workspaceDir);
	} else if (typeof file.workspaceDir === "string") {
		config.workspaceDir = expandTilde(file.workspaceDir);
	}
	if (typeof file.host === "string" && file.host !== "") config.host = file.host;
	if (typeof file.token === "string" && file.token !== "") config.token = file.token;
	if (file.tailscaleAuth === true) config.tailscaleAuth = true;
	const notifications = parseNotifications(file.notifications);
	if (notifications) config.notifications = notifications;
	return config;
}

function parseNotifications(raw: unknown): FleetNotificationConfig | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const file = raw as Record<string, unknown>;
	const out: FleetNotificationConfig = {};
	if (typeof file.vapid === "object" && file.vapid !== null && !Array.isArray(file.vapid)) {
		const v = file.vapid as Record<string, unknown>;
		if (
			typeof v.publicKey === "string" &&
			typeof v.privateKey === "string" &&
			typeof v.subject === "string"
		) {
			out.vapid = { publicKey: v.publicKey, privateKey: v.privateKey, subject: v.subject };
		}
	}
	if (
		typeof file.telegram === "object" &&
		file.telegram !== null &&
		!Array.isArray(file.telegram)
	) {
		const t = file.telegram as Record<string, unknown>;
		if (typeof t.botToken === "string" && typeof t.chatId === "string") {
			out.telegram = {
				botToken: t.botToken,
				chatId: t.chatId,
				webhookSecret: typeof t.webhookSecret === "string" ? t.webhookSecret : undefined,
				poll: t.poll === true,
			};
		}
	}
	if (!out.vapid && !out.telegram) return undefined;
	return out;
}

function applyNotificationEnv(config: FleetConfig): void {
	const pub = process.env.OMP_FLEET_VAPID_PUBLIC_KEY;
	const priv = process.env.OMP_FLEET_VAPID_PRIVATE_KEY;
	const sub = process.env.OMP_FLEET_VAPID_SUBJECT;
	const bot = process.env.OMP_FLEET_TELEGRAM_BOT_TOKEN;
	const chat = process.env.OMP_FLEET_TELEGRAM_CHAT_ID;
	if (pub && priv && sub) {
		config.notifications = {
			...config.notifications,
			vapid: { publicKey: pub, privateKey: priv, subject: sub },
		};
	}
	if (bot && chat) {
		config.notifications = {
			...config.notifications,
			telegram: {
				botToken: bot,
				chatId: chat,
				webhookSecret: process.env.OMP_FLEET_TELEGRAM_WEBHOOK_SECRET,
				poll: process.env.OMP_FLEET_TELEGRAM_POLL === "1",
			},
		};
	}
}

function isTemplateMap(value: unknown): value is Record<string, SpawnTemplate> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every(
		(t) => typeof t === "object" && t !== null && typeof (t as SpawnTemplate).command === "string",
	);
}

function isProjectTemplateMap(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((name) => typeof name === "string");
}
