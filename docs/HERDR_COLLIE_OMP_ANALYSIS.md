# Herdr, Collie, OMP, and OMP-Web: Architectural Evaluation & Code Review

## 1. System Ecosystem & Architectural Roles

| System | Role & Transport | Core Abstractions & State |
| :--- | :--- | :--- |
| **Herdr** (`~/.config/herdr`, `~/.local/bin/herdr`) | Host PTY multiplexer & process supervisor on macOS/Linux. Unix socket JSON-RPC (`~/.config/herdr/herdr.sock`). | Workspaces $\to$ Tabs $\to$ Panes. Manages PTY lifecycle, signals, and agent process status (`idle`, `working`, `blocked`, `done`). |
| **Collie** (`herdr.collie`) | Mobile web bridge & PWA running as launchd/systemd service over `tailscale serve`. | React + Vite PWA, ServiceWorker (`sw.ts`), WebPush, HTTP polling on `/api/snapshot`, heuristic regex terminal parser (`lib/harness/omp/`). |
| **OMP Core** (`@oh-my-pi/pi-coding-agent`) | Core AI coding harness & in-process SDK. | In-process agent engine, `ExtensionUIContext` for user dialogs, subagent trees, token telemetry, `.jsonl` durable transcripts. |
| **OMP-Web** (`nibblebot/omp-web`) | Multi-session Web UI and Fleet Supervisor for OMP. | Solid.js UI, Bun server, SSE + POST wire protocol (`OMP_PROTO 2`), `omp-fleet` supervisor + `/ctl` API, in-process `omp-session` daemons. |

---

## 2. In-Depth Comparative Matrix

| Feature | Herdr + Collie | OMP-Web (`nibblebot/omp-web`) |
| :--- | :--- | :--- |
| **Control Model** | PTY / Virtual Terminal grid | Direct In-Process TypeScript SDK (`createAgentSession`) |
| **Transport** | Unix Socket JSON-RPC + HTTP Polling | Monotonic SSE Delta Rings (`GET /events`) + HTTP (`POST /command`) |
| **Prompt / Dialog Capture** | Heuristic regex matching on screen text (fragile; misses question context) | Exact structured `ui_request` (title, message, placeholder, options); epoch-scoped `POST /ctl/dialog/reply` |
| **Mobile & Alerts** | First-class PWA, WebPush, "Needs You" triage, haptics, swipe gestures | PWA (`public/sw.js`), WebPush (VAPID), Telegram inline keyboards, safe-area / `100dvh` tokens. Device QA still operator-side. |
| **Remote Access & Auth** | Native `tailscale serve` with identity headers & CSRF protection | Default loopback; `--host` + `--token` or `--tailscale-auth`; CSRF on mutating fleet HTTP |
| **Subagent Telemetry** | Unparsed stdout text in terminal screen | Visual tree, per-subagent transcript readers, step counters |
| **Process Breadth** | Universal (any CLI binary, test runner, script) | OMP agent sessions plus isolated `PtySupervisor` for non-OMP commands |
| **State Resilience** | Process memory + PTY ring buffer | Durable `.jsonl` transcript files + bounded in-memory replay ring |

---

## 3. Reviewer-Validated Technical Findings & Constraints

An independent architectural review conducted on 2026-08-22 identified the following constraints. They are the reason the convergence work exists. **Implementation status is in section 4.**

### 3.1 Security Boundary (P0 Requirement)
- At review time, `omp-fleet` bound `127.0.0.1` and applied **no caller authentication or CSRF/Origin checks** on mutating `/ctl/` and `/command` routes.
- The existing bearer token contract protected `omp-fleet` to `omp-session` connections, not external callers to `omp-fleet`.
- **Constraint:** Before exposing `omp-fleet` to Tailscale or remote bots, implement single-operator authentication (bearer token / Tailscale identity) and CSRF validation for browser writes.

### 3.2 Offline Observer & UI Alert Channel
- In `omp-session`, `webUiRequest` fails immediately if no `/events` stream is attached.
- The fleet connector intentionally drops unretained control streams after 60s when no browser is connected.
- **Constraint:** We must introduce a dedicated background observer/request-broker on `omp-fleet` that captures `ui_request` and `agent_end` events without suppressing the daemon's natural idle shutdown.

### 3.3 Atomic, Typed Dialog Resolution
- Naive fire-and-forget POSTs to `/command` (`ui_response`) risk applying stale or mismatched answers (e.g. after daemon restart, where request IDs reset to `ui1`).
- **Constraint:** Dialog response endpoints must use epoch-scoped tokens (`daemonId:bootEpoch:requestId`), validate method-specific payload types (`confirm`, `select`, `input`, `askDialog`), and enforce idempotency.

### 3.4 Event Source vs. REST Projection
- Removing SSE complexity for bots (Telegram, Hermes) is essential, but HTTP snapshot polling alone cannot reliably capture transient `agent_end` or fast-closing dialogs.
- **Constraint:** Keep the internal SSE stream as the single event source, and project its state into an in-memory REST read-model for fast queries.

### 3.5 Process Supervision Separation
- Arbitrary CLI processes (test runners, bash scripts) cannot use OMP daemon templates because they do not emit the `OMP_SESSION|listening` handshake.
- **Constraint:** General CLI execution requires a separate PTY worker supervisor and terminal streaming protocol, isolated from OMP SDK daemons.

---

## 4. Implementation status (2026-08-22)

| Constraint | Shipped in |
| :--- | :--- |
| 3.1 Fleet operator auth + CSRF | `fleet/auth.ts`, `fleet/server.ts` `#fetch`, `--token` / `--tailscale-auth` / `--host` |
| 3.2 Observer without idle pin | `fleet/observer.ts`, `GET /events?role=observer`, `SseConsumer.observer` |
| 3.3 Epoch-scoped dialog reply | `fleet/dialog-reply.ts`, `POST /ctl/dialog/reply`, projector epochs |
| 3.4 SSE source + REST snapshot | `fleet/projector.ts`, `GET /ctl/herd` |
| 3.5 Isolated non-OMP process runner | `fleet/pty-supervisor.ts`, `/ctl/pty*` |

Collie-adjacent extras that shipped with the same work: `fleet/notifications/` (WebPush + Telegram), `public/manifest.webmanifest` + `public/sw.js` + `src/pwa.ts`.

`omp-gui` (oh-my-pi omp2) is a native TUI host. It does not close these constraints. See `docs/position.md`.

