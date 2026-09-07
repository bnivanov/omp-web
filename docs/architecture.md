# omp-web: System architecture

Overall architecture for omp-session + omp-fleet. Product positioning lives in [`position.md`](position.md); convergence as-built spec in [`CONVERGENCE_BLUEPRINT.md`](CONVERGENCE_BLUEPRINT.md); per-command usage is in the [README](../README.md).

## Topology

```
browser / PWA (Solid, one app, two modes)
   ⇄ SSE/POST ⇄ omp-session (standalone: full single-session UI)
   ⇄ SSE/POST ⇄ omp-fleet (roster mode) ⇄ per-browser proxied SSE/POST ⇄ omp-session …
                                      ⇄ control SSE/POST ⇄ omp-session …  (remote: ssh -L / tailnet / direct)
                                      ⇄ GET /ctl/herd, POST /ctl/dialog/reply  (bots / CLI)
Telegram / WebPush  ← observer tap (ui_request, agent_end; does not pin idle)
```

One web app, two modes. Standalone: the browser talks to one omp-session daemon directly. Roster: the browser talks to omp-fleet's edge, which proxies each attached browser through to the selected daemon.

## Architecture diagram

```mermaid
flowchart TB
  subgraph web["Web UI, Solid.js bundle (src/)"]
    store["state.ts, single createStore<br/>SSE stream + call()/POST"]
    ui["App.tsx + thin components"]
  end

  subgraph fleet["omp-fleet, registry + supervisor + edge (fleet/)"]
    edge["edge.ts, browser SSE/POST · per-browser daemon pipes"]
    conn["connector.ts, per-daemon SSE client (dial-in)"]
    super["supervisor.ts, spawn/restart · parses OMP_SESSION| lines"]
    reg["registry.ts, dN/pN roster · zero agent state"]
  end

  subgraph sdk["omp-session, session SDK wrapper (server/)"]
    daemon["SSE /events · POST /command<br/>methods.ts dispatch · readiness gate"]
    wrap["createAgentSession, in-process<br/>@oh-my-pi/pi-coding-agent"]
    log[".jsonl session log, durable truth"]
  end

  model["Agent model provider"]

  ui --> store
  store -->|"POST /command, commands up"| edge
  edge -->|"SSE /events, frames down"| store
  edge <-->|"proxied session frames"| conn
  conn <-->|"bearer · hello_ok/proto gate · Last-Event-ID resume"| daemon
  super -. "spawn · endpoint · --resume" .-> daemon
  reg --> super
  daemon <--> wrap
  wrap <--> model
  wrap -.-> log
  store <-->|"standalone mode: direct, fleet bypassed"| daemon
```

## Layers and import discipline

Strictly leaf-ward layering, verified across the tree:

- **`shared/`**: the leaf: `protocol.ts` (wire contract) and `sse.ts` (SSE codec + ring). Imports nothing in the repo.
- **`server/`**: the omp-session daemon. Imports from `shared/` only.
- **`fleet/`**: the omp-fleet supervisor/registry/edge. Imports from `shared/`; from `server/` only two deliberate exceptions: `edge.ts` pulls `EMBEDDED_DIST` from `server/embedded-dist` to serve the embedded UI bundle, and `settings.ts` imports types from `server/settings-model` to reuse the shared settings metadata.
- **`src/`**: the Solid browser client. Imports from `shared/` only; imports neither backend layer.

fleet↔session coupling is exactly one wire-contract file plus one SSE codec, with `OMP_PROTO` gating drift at hello; the two deliberate `server/` imports above are the only cross-seam exceptions.

## The wire contract (`shared/protocol.ts`, OMP_PROTO 2)

- **Transport:** `GET /events` (SSE, server→client, all frames) + `POST /command` (client→server, one `ClientCommand` per request, `202` accept). Answers ride the SSE stream only: one answer channel. No WebSocket on the agent-driving path; WS remains solely on the collab relay.
- **Priming sequence** on every `/events` open: `hello_ok` → `attached` → `history` → `state` → `collab_status` → `available_commands` → `ready`. Connect implies attached.
- **Resume:** daemon-global monotonic delta seqs; a bounded ring (10k entries) replays deltas past `Last-Event-ID`. Priming is fresh and current, so stale clients skip replay. Consumers dedup by id (`call_result` resolves only a pending call).
- **Keepalive:** id-less `ping` events (never advancing resume counters); consumers treat >2× the ping interval of silence as a dead peer and reconnect.
- **Backpressure:** a stream whose enqueue would exceed 4 MiB is terminated with an error: drop-and-resume, the consumer redials with `Last-Event-ID` and the ring covers the gap.
- **Idempotency:** POST commands dedup by client-supplied id within a bounded window; duplicates get another `202`.
- **Evolution rule:** additive changes only. `OMP_PROTO` (currently 2) must bump on any breaking change to the handshake or frame shapes.
- **Project/worktree onboarding (additive):** new project/worktree/branch `ClientCommand` variants, full shapes in `shared/protocol.ts`, which the edge answers in-process via the shared registry/supervisor/worktrees module, its fail-closed command allowlist growing with them; parallel `/ctl` routes serve the CLI/API. New fleet-scoped frames: `registered_projects` (broadcast; lets project groups with zero daemons render), `daemon_activity`, and `daemon_sessions`. `DaemonEntry` gains optional `projectId` and `managed` fields (absent for remote entries and older edges).
- **Real-time daemon activity (additive, fleet-scoped):** `daemon_activity` `{daemonId, streaming, blocked}`, edge-generated from the per-daemon control-tap (state → isStreaming; ui_request/ui_request_end → the open-dialog set), broadcast on change and primed once per known ready daemon on stream open; never carries a sessionId and is stripped from proxy pipes like `daemons` rosters. While any browser stream is open, the edge retains+dials every ready daemon so activity stays live: that retention counts as an attached client and suspends those daemons' idle auto-exit until the last browser disconnects, then releases and the normal 60s idle-drop resumes. Never carries tokens/endpoints.
- **Roster session dropdown (additive, fleet-scoped):** clicking a roster row opens a per-worktree session picker, `list_daemon_sessions` `{daemonId}` (edge-handled) listed from disk via the SDK's `SessionManager` (new `fleet/daemon-sessions.ts`, lazy import so the fleet stays SDK-free at static load) and answered with unicast `daemon_sessions` `{daemonId, sessions}` (newest-first, ≤10, not ringed, re-POSTed like `projects`), so asleep/never-started daemons answer too. Resuming a picked session: `spawn_resume` gains optional `sessionFile` (edge validates membership against the same listing before `--resume <file>`), and ready daemons use attach+`switchSession`. `DaemonEntry` gains optional `sessionEmpty` (probed like `sessionTitle` from the last session file: missing or messageless = empty), the row renders a bare "New session" title instead of nothing.
- **Spawn contract (R6b):** omp-session prints `OMP_SESSION|{"event":"listening",…}` on **stdout** immediately after bind, before session creation, so a spawner learns the endpoint early. The advertised `url` is `ws://`-shaped for legacy reasons; consumers normalize via `daemonHttpBase` (ws→http, wss→https, strip path). A remote wrapper may print a later `{"event":"endpoint"}` line when the reachable address differs from the bind.

## omp-session daemon (`server/`)

One process, one bound cwd (immutable), one live in-process SDK session (`createAgentSession`, no child process, no JSON-RPC hop). Sequential session *replacement* (`newSession`, `switchSession`, `branch`, `fork`, `handoff`, `compact`, `retry`, `freshSession`); concurrency lives one layer up in omp-fleet. Disk `.jsonl` logs make the daemon disposable: respawn with `--resume` and the transcript is back.

Module map (split along the seams identified in the 2026-08 audit):

- `index.ts`: boot, HTTP routing, dispatch wiring, readiness gate, idle auto-exit, signal/shutdown, static UI serving (`embedded-dist.ts`), bearer auth (R14: loopback exempt, off-loopback hard-requires `--token`), `/download` realpath jail.
- `methods.ts`: the `WebMethodName` dispatch table.
- `sse-delivery.ts`: stream registry, ring, broadcast, backpressure termination.
- `ui-context.ts`: `ui_request`/`ui_response`/`ui_request_end` dialog relay (ExtensionUIContext), incl. collab fallthrough.
- `subagent-mirror.ts`: subagent lifecycle/progress mirror + byte-offset transcript reader; steer/abort.
- `daemon-broker.ts`: the omp hub daemon-broker polling/control client behind the ActiveDaemons panel.
- `session-entry.ts`, `settings-model.ts`, `config.ts`: session state snapshots, settings model + side effects, flag/env parsing.
- `collab-host.ts`, `collab-relay.ts`, `collab-session.ts`, `collab-cli.ts`: the collab room machinery (see below).

Lifecycle gates: a **boot gate** preserves connect-implies-attached for streams that race session creation; a **readiness gate** fails prompt-family calls with `not_ready` until provider/model/auth resolution completes and the daemon broadcasts `ready`. **Idle exit:** with no attached *non-observer* clients, running agent/queue, in-flight bash/eval, open dialog, or live collab room, the daemon exits cleanly after the idle timeout: the `.jsonl` is already durable. `GET /events?role=observer` sets `SseConsumer.observer` and does **not** suppress idle (fleet observer / notify path).

## omp-fleet (`fleet/`)

Holds the registry of N daemons and zero SDK state: all agent truth lives in the omp-session processes and their `.jsonl` logs. Fleet and session files are exclusively pidfile-locked for the owning process's lifetime (self-healing via pid liveness), so a second fleet, or a second daemon resuming the same session file, refuses to start instead of clobbering state.

- `registry.ts`: JSON persistence (atomic tmp+rename on every mutation) to `~/.omp-web/fleet-state.json` (env `OMP_FLEET_STATE`), monotonic `dN` id allocation floored above the max id found on disk, boot-time status reconciliation, and the first-class `projects[]` (`pN` monotonic ids, realpath-keyed, deduped on registration: a duplicate realpath returns the existing project; `removeProject` implicitly drops provably-empty placeholder entries (the auto-registered, never-started default workspace: spawned/asleep, no lastSessionFile, no endpoint) and refuses while any REAL roster entry references it, naming the blockers; never touches disk). Projects persist in the same atomic state file; project-set mutations fire a dedicated `onProjectsChange` hook (edge → `registered_projects` broadcast). Roster serialization (`toRosterEntry`) structurally strips token/endpoint/template before anything reaches a browser.
- `discovery.ts`: project discovery: roots one level deep, git repos + worktrees.
- `worktrees.ts`: managed-worktree path mapping + lifecycle. Layout: `<workspaceDir>/<repo-basename>/<slug(name)>` under the `workspaceDir` knob (env `OMP_FLEET_WORKSPACE_DIR`, flag `--workspace-dir`, config-file key, default `~/.omp-web/workspaces`; created lazily on first worktree, never at boot); a repo-basename collision gets a `-<sha1-prefix>` suffix via the `<basename>/.omp-web-repo` ownership marker. Lifecycle: `resolveBaseRef` (`git symbolic-ref refs/remotes/origin/HEAD` → local default branch → current HEAD, no fetch), `createWorktree` (branch = slugified name, or attach an existing not-checked-out branch; refuses an existing target dir or a checked-out branch), `listProjectBranches` (local branches + checked-out state via for-each-ref/worktree-list, feeds the branch picker), `listUnregisteredWorktrees` (linked worktrees minus registered, feeds the Add-existing tab), `worktreeDeleteInfo` (owned/dirty + branch merge/push evidence) and `deleteWorktree` (ownership = realpath under `workspaceDir`, clean-only, dirty refuses, no `--force`; optional `git branch -d`, never `-D`), plus `registerWorktreeEntry` (roster entry `mode: "spawned"` tagged `projectId`/`worktreeOf`, optional spawn) and `registerProjectMainEntry`: registering a project auto-registers its DEFAULT WORKSPACE: a roster entry for the main checkout mapped to the repo CWD (never a managed worktree under `workspaceDir`), asleep and wakeable via `spawn_resume` unless `start` spawns it live.
- `supervisor.ts` + `spawn-parse.ts`: spawns children from **command templates** (never a hardcoded launch method): `{cwd}`/`{token}`/`{name}`/`{labels}`/`{resume}` substitution is shell-escaped; child stdout is parsed for `OMP_SESSION|` lines; endpoint resolution precedence is wrapper `endpoint` line › template `host` + port › `advertise` › loopback, with a 30s resolution timeout. Fresh 32-byte token per spawn attempt; respawn is serialized per daemon (mutex) with `--resume`; restart-on-failure with a bounded consecutive-crash budget (the counter resets on ready); SIGTERM→SIGKILL escalation; intentional-stop/manual-respawn flags so expected deaths don't trigger restarts.
- `session-title.ts`: read-only session probe for the roster's `sessionTitle`/`sessionEmpty` fields: bounded 8KB head read of `lastSessionFile` (256B title slot preferred, session-header title fallback; emptiness = whole file inside the head with no `{"type":"message"` entry), LRU-cached by `(path, mtimeMs, size)`; called from the supervisor's git-state poll, never for remote entries, registry updated only on change.
- `connector.ts`: dials each daemon (dial-in only; daemons never dial out) with bearer auth, verifies `hello_ok.cwd` against the registry entry and `OMP_PROTO` against the local version before the daemon is drivable, keeps liveness via the SSE silence deadline, and redials with `Last-Event-ID` + jittered exponential backoff. `retain`/`release` arms an idle-drop so unused control sockets close and the daemon's own idle timer can fire.
- `edge.ts`: the browser surface: browser SSE + POST, per-browser daemon pipes and rings (one slow browser is dropped and resumed without stalling others), `sessionId` stamping on all session-scoped frames (guards cross-daemon contamination on session switch), a waking-set serializing spawn-resume vs attach, and fail-closed command/frame allowlists kept exhaustiveness-safe against the protocol union at compile time (the allowlist gained the project/worktree onboarding commands).
- `fanout.ts` + `selectors.ts`: `dN` / `all` / glob / `label:k=v` / `project:name` selectors and fan-out prompting with per-turn correlation on each target's `agent_end`.
- `events.ts`: `FleetEventLog` + `FleetFacts`: capped lifecycle-event ring (daemon status changes, spawn/exit/respawn, control-route failures; default 500 entries) fed to `/ctl/debug` and the serve-mode CLI banner; entries never hold secrets.
- `settings.ts`: the unattached settings surface (`/ctl/settings`): lazily initializes the process-global `Settings` singleton (the same instance a session reads) and builds the wire `SettingsModel` from `server/settings-model` metadata, persisting coerced values without live session side effects.
- `auth.ts`: fleet operator gate for every `fetch` (`/ctl`, `/command`, `/events`). Loopback CLI (no Origin) allowed; off-loopback needs bearer or Tailscale-User-Login from CGNAT; mutating browser calls need CSRF (`x-omp-csrf`, same-origin, or loopback-to-loopback Origin). `assertFleetBindSafe` refuses a non-loopback bind without token or `--tailscale-auth`.
- `projector.ts` + `dialog-reply.ts`: in-memory herd read-model (`GET /ctl/herd`, no tokens/endpoints) and epoch-scoped `POST /ctl/dialog/reply` (`applied` / `already_applied` / `expired`).
- `observer.ts`: taps connector frames; after idle-drop of a still-ready daemon, dials `/events?role=observer`. Feeds projector + notifications. Does not pin daemon idle-exit.
- `notifications/`: WebPush (VAPID, RFC 8291/8292) + Telegram (inline keyboards, short `tN` callback ids). Optional; no-op without config/env keys.
- `pty-supervisor.ts`: isolated non-OMP process runner (`/ctl/pty*`, 512 KiB ring, max 32 workers). Not an SDK daemon template.
- `server.ts` + `cli.ts`: control API and the `omp-fleet` / `omp-web` CLI (including `herd`, `dialog-reply`, `pty-*`, `--host` / `--token` / `--tailscale-auth`); `daemons-aggregator.ts`: the aggregated daemons panel feed. Control-plane routes added by onboarding: `GET /ctl/projects` → `{ projects: ProjectEntry[], registered: RegisteredProject[] }` (discovery stays ephemeral + read-only; the registered set is merged alongside), `POST /ctl/projects` `{path, start?, template?, labels?}` → `201 {project, entry?}` | `400` bad path | `409` dedup (already registered), `DELETE /ctl/projects/:projectId` → `200 {removed}` | `409` naming referencing daemons | `404`, `POST /ctl/projects/:id/worktrees` (create-new `{name, baseRef?, existingBranch?, start?}` | add-existing `{worktreePath, start?}`) → `201 {entry}`, `GET /ctl/worktrees/:daemonId/delete-info`. Also `GET /ctl/herd`, `POST /ctl/dialog/reply`, `/ctl/push/*`, `/ctl/telegram/webhook`, `/ctl/pty*`.

## Browser client (`src/`)

One Solid app. `state.ts` is the store: chat items, streaming, session-state mirror, roster state, `call()` helper over POST, reconnect with backoff, and a stale-frame guard keyed on the stamped `sessionId` so frames from a previously attached daemon are never applied to the current view. `App.tsx` holds exactly one mode branch (the DaemonSidebar); everything else (subagent drill-down, settings, export, pickers, login, `/btw`, goal, usage) works identically in both modes. `src/pwa.ts` registers `public/sw.js`, optionally subscribes Web Push via `/ctl/push/*`, and honors `?daemon=` / `notificationclick` deep links. Manifest and icon live under `public/`.


## State ownership

The SDK session and its `.jsonl` log are the single agent truth. The fleet registry only mirrors defined wire points (cwd from validated hello, sessionFile from hello/state frames, readyAt from the ready frame). The client resets its per-session view on every attach. Nothing assumes process permanence: daemons are disposable by design.

## Security model

- **Dial-in only:** omp-fleet initiates every connection; omp-session never dials out and has no `--fleet` flag. A sandbox image knows nothing of the external world; egress may be denied entirely.
- **Per-daemon bearer tokens** minted at spawn; a leaked token gates that one daemon only. Loopback exempt; off-loopback requires the token plus a secure transport (ssh `-L`, tailnet, or own TLS).
- **Fleet operator auth:** every fleet `fetch` runs `authorizeFleetRequest`. Off-loopback needs `config.token` or Tailscale identity (`--tailscale-auth` + `Tailscale-User-Login` from `100.64/10`). Binding a non-loopback host without those is a startup error. Mutating browser calls need CSRF; loopback CLI (no Origin) is allowed.
- **Roster hygiene:** tokens/endpoints/templates never serialize into roster frames, `/ctl/herd`, or `/ctl/debug`.
- **Egress:** `/download` is realpath-jailed to the bound cwd + tmpdir + session dirs: the only file-egress path; `list_files` never escapes the cwd.


## Collab (the WebSocket exception)

Collab rooms are the one remaining WS surface: an E2E-encrypted relay (`/r/<roomId>`) owned by `@oh-my-pi/pi-coding-agent/collab`, shared with the TUI collab mux, deliberately untouched by the SSE migration. Hosts create rooms off-loopback only with the daemon token; guests join with the room key from a shareable link (no account). Rooms are capped (`OMP_SESSION_COLLAB_MAX_ROOMS`, default 256; guests 64). There is no collab surface in the web UI by design: rooms are hosted and joined from the CLI/TUI.
