# Project Status & Session Log

## 1. Standing Rules

> **Standing Rule - Continuous Session Capture:**
> At the end of every assistant turn/response, a relevant document in this working folder (e.g. `docs/STATUS.md`) must be updated to maintain thorough, consistent, and up-to-date tracking of findings, architectural decisions, and progress.

---

## 2. Project State

- **Date:** 2026-09-07
- **Current Milestone:** Fork initialized on our side (`bnivanov/omp-web`), remotes wired, types verified, and `fleet-convergence` branch created
- **Workspace:** `/Users/agentlab/AgentWork/projects/terminal-guis/omp-web`
- **Upstream Repository:** `https://github.com/nibblebot/omp-web` (`upstream`)
- **Origin Repository:** `https://github.com/bnivanov/omp-web` (`origin`)
---

## 3. Completed this session

- [x] Implemented CONVERGENCE_BLUEPRINT Phases 1–4 (auth/CSRF, herd projector, dialog reply, observer, WebPush/Telegram, PWA, PTY).
- [x] Verified: `bun run check:types`; 169 tests across auth, projector, dialog, observer, pty, notifications, server-herd, server-routes, server-cli, connector, edge-wire, edge-activity, config, cli.
- [x] Darwin spawn fixture: `FAKE_CWD` is realpath'd in `fleet/edge.testkit.ts` so hello cwd matches `validateProjectPath`.
- [x] Evaluated Discord claim that omp2 `omp-gui` makes omp-web irrelevant: **false**. See `docs/position.md`.
- [x] Project docs updated to as-built: `STATUS.md`, `CONVERGENCE_BLUEPRINT.md`, `position.md`, `architecture.md`, `HERDR_COLLIE_OMP_ANALYSIS.md`, `AGENTS.md`, `README.md`.
- [x] Installed this checkout (`bun run install:omp-web`) to `~/.bun/bin/omp-web` (0.1.1). Wrote `~/.omp-web/config.json`. Fleet serving `127.0.0.1:4722`. Registered `p1` / `d2` (omp-web checkout) ready.
- [x] Dispatcher now routes `herd` / `dialog-reply` / `pty-*` (`cli/omp-web.ts`). `cli/omp-web.test.ts` 7/7.
- [x] Control-plane token sanitization: All `/ctl` endpoints (`/ctl/sessions`, `/ctl/spawn`, `/ctl/projects`, `/ctl/add`, `/ctl/provision`, `/ctl/projects/:id/worktrees`) sanitized via `toRosterEntry` to prevent token/endpoint exposure.
- [x] Full test suite green: 1,087 / 1,087 tests pass across 85 files; `check:types` 0 errors; `oxfmt` and `oxlint` clean.
- [x] Authored `docs/DOGFOOD_E2E_TESTING.md`: end-to-end dogfooding guide and step-by-step operational scorecard contrasting OMP-Web with Herdr/Collie.

### 2026-09-07
- [x] Verified upstream status: Upstream `nibblebot/omp-web` latest commit on `main` is `afc5de1` (v0.1.1). Local checkout was already based directly on `afc5de1` (not behind upstream main).
- [x] Forked repository to user GitHub account `bnivanov/omp-web` via `gh repo fork --remote=true`. Configured `origin` to `bnivanov/omp-web` and `upstream` to `nibblebot/omp-web`.
- [x] Resolved test typecheck mismatches in `fleet/notifications/telegram-inbound.test.ts` and `telegram-isolation.test.ts` (`labels: []`, `templates: {}`, `defaultTemplate`).
- [x] `bun run check:types` passes cleanly.
- [x] Created dedicated development branch `fleet-convergence` to track Convergence Blueprint work independently of upstream `main`.

---

## 4. Roadmap (as-built)

1. **Phase 1: Security Hardening & Fleet Read-Model API**
   - [x] Caller authentication (bearer / Tailscale) and CSRF on `/ctl` and `/command`.
   - [x] In-memory event projector for `/ctl/herd`.
   - [x] Atomic epoch-scoped `POST /ctl/dialog/reply`.
2. **Phase 2: Background Observer & Notification Engine**
   - [x] Non-suppressive observer channel for `ui_request` and `agent_end`.
   - [x] WebPush (VAPID) and Telegram dispatchers with action buttons.
3. **Phase 3: Mobile PWA Packaging**
   - [x] Manifest + ServiceWorker with push + notificationclick.
   - [x] Safe-area / drawer / virtual-keyboard viewport tokens.
4. **Phase 4: Generic PTY Supervision**
   - [x] General-purpose CLI process runner in omp-fleet.

Open follow-ups (not started):

- Operator must supply VAPID keys / Telegram credentials before those channels fire.
- Device-level PWA / iOS-Android gesture QA.
- `server/omp-session` off-loopback static `/` needs a built `dist/` (or `bun run build` embedded dist).

---

## 5. Implementation notes

- Tokens/endpoints never appear on `/ctl/herd` or roster frames.
- Observer streams receive frames but do not count as attached clients for idle auto-exit. A retained **browser** connector stream still suspends idle while any browser is connected.
- Telegram callback_data is a short `tN` id (64-byte cap); the binding maps back to an epoch token.
- WebPush: `notifications.vapid` or `OMP_FLEET_VAPID_{PUBLIC_KEY,PRIVATE_KEY,SUBJECT}`.
- Telegram: `notifications.telegram` or `OMP_FLEET_TELEGRAM_{BOT_TOKEN,CHAT_ID}` (+ optional `WEBHOOK_SECRET`, `POLL=1`).
- Service worker lives at `public/sw.js`, not `src/sw.ts`.
- Fleet bind: `--host` / `OMP_FLEET_HOST` (default `127.0.0.1`). Non-loopback bind requires `--token` or `--tailscale-auth`.

---

## 6. omp-gui (omp2) vs omp-web

Discord claim that [can1357/oh-my-pi `omp2/crates/gui`](https://github.com/can1357/oh-my-pi/tree/omp2/crates/gui) makes omp-web irrelevant: **false**.

`omp-gui` is a wgpu host for the same `omp-tui` cell grid. The published chat example uses a mock backend. The browser example embeds a webview as a pixel surface. omp-web's load-bearing surface is the HTTP+SSE fleet edge, N disposable daemons, worktrees, remote/mobile ingress, `/ctl/herd`, observer, WebPush/Telegram, PWA. Composition later is possible. Substitution is not. Full write-up: `docs/position.md`.
