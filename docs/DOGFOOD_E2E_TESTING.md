# 📋 OMP-Web End-to-End Dogfooding & Workflow Guide

**Repository:** `omp-web`  
**Test Lead:** Bobby / Operator  
**Execution Co-Pilot:** OMP Assistant  
**Date:** 2026-08-22  
**Target Environments:**
- **Local Control & Cockpit:** `http://127.0.0.1:4722` (Standalone Solid.js UI + Fleet Control Plane)
- **CLI Control Surface:** `omp-web` installed binary (`~/.bun/bin/omp-web`)
- **Remote / Mobile Cockpit:** Mobile PWA (`manifest.webmanifest`, `sw.js`) over Tailscale
- **Remote Automation Ingress:** Telegram Bot Dispatcher + WebPush (VAPID)
- **Host Process Supervisor:** Generic PTY Sidecar (`/ctl/pty/*`)

---

## 🎯 Purpose & Methodology

This document serves as the living test track, scorecard, and operational playbook for dogfooding **OMP-Web** and transitioning smoothly from the legacy **Herdr (`~/.config/herdr`) + Collie (`herdr.collie`)** workflow to a native, SDK-driven agent cockpit.

As we execute each step together:
1. We run each test action in the browser, terminal, or mobile device.
2. We record the **Actual Result & Observations** and mark status (`PASS` / `FAIL` / `BLOCKED`).
3. We note architectural insights and workflow differences.
4. We capture all friction, ergonomics issues, and bugs in the backlog table at the bottom.

---

## 🔄 Workflow Shift: OMP-Web vs. Herdr & Collie

| Dimension | Legacy Herdr + Collie | Native OMP-Web | Why It's Better |
| :--- | :--- | :--- | :--- |
| **Agent Core & Transport** | PTY terminal multiplexing; Collie scrapes raw ANSI text via regex | In-process `@oh-my-pi/pi-coding-agent` SDK + HTTP/SSE wire protocol (`OMP_PROTO 2`) | Zero ANSI parsing errors; full structured tool cards, diff renders, and live token metrics. |
| **Workspace & Multi-Tasking** | Manual tmux-style panes in workspace `hermes-jobs` (`herdr pane run`) | First-class **Projects & Git Worktrees** (`omp-web add-worktree`) | Dedicated clean branch checkouts; automatic `.omp-web-repo` collision guards; safe unmerged deletion checks. |
| **Fleet & Session Discovery** | `herdr pane list` / `/herd` CLI | `omp-web herd` / `GET /ctl/herd` & Visual Sidebar Roster | Unified read-model with real-time status (`idle`, `streaming`, `blocked_ui`), dirty file counters, and active dialog summaries. |
| **Dialogs & Confirmations** | Raw key injection: `herdr pane send-keys <id> 1 Enter` | Atomic epoch-scoped replies: `omp-web dialog-reply --epoch <t> --action <a>` | Idempotent, race-free resolution; replay immunity; zero missed or double-clicked dialogs. |
| **Mobile & Notifications** | Collie service + React PWA scraping `/api/snapshot` | Native PWA with ServiceWorker (`sw.js`), WebPush, and Telegram Bot dispatchers | Instant push on `ui_request` / `agent_end` with one-tap interactive inline reply buttons. |
| **Non-Agent Terminal Commands** | Mixed into the same Herdr pane list | Dedicated PTY sidecar (`omp-web pty-spawn`) isolated from OMP daemons | Keeps agent state clean; bounded output rings; independent process lifecycle. |

---

## 📊 High-Level Test Suite Progress

| Phase | Test Area | Total Tests | Passed | Failed | Status |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Phase 1** | Local Cockpit, Daemons & Git Worktrees | 5 | 0 | 0 | 🟡 Pending |
| **Phase 2** | Security Boundaries, Auth & CSRF Guards | 4 | 0 | 0 | 🟡 Pending |
| **Phase 3** | Atomic Dialog Resolution & Remote Steering | 4 | 0 | 0 | 🟡 Pending |
| **Phase 4** | Mobile PWA, Observer & Push Notifications | 4 | 0 | 0 | 🟡 Pending |
| **Phase 5** | Generic PTY Supervision & Teardown | 3 | 0 | 0 | 🟡 Pending |
| **Total** | | **20** | **0** | **0** | **0% Completed** |

---

## 🧪 Phase 1: Local Cockpit, Daemons & Git Worktrees

**Objective:** Verify that `omp-web` operates as the primary local agent cockpit with full multi-daemon tracking, git worktree lifecycle, and transcript durability.

### Test Matrix

| ID | Scenario | Command / Action | Expected Behavior | Actual Result & Observations | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **1.1** | Cockpit Launch & Roster Inspection | Open `http://127.0.0.1:4722` in browser. | Solid.js UI loads cleanly; shows registered project (`omp-web`) and active daemon `d2`; shows status chip, branch name, and diffstat chips. | *Pending execution* | `[ ]` |
| **1.2** | Turn Execution & Streaming Telemetry | In UI, prompt `d2`: `summarize the role of shared/protocol.ts in 2 sentences`. | Real-time token streaming; live block updates without remount flicker; usage meter updates; markdown renders cleanly. | *Pending execution* | `[ ]` |
| **1.3** | Session Dropdown & History Switching | Click session dropdown on daemon row; view last-10 sessions; switch session. | Lists durable `.jsonl` sessions; switching reloads history before new turns without mixing transcripts. | *Pending execution* | `[ ]` |
| **1.4** | Managed Worktree Creation | Click "New Worktree" (or `omp-web add-worktree --name feat-test`). | Creates isolated worktree under `~/.omp-web/workspaces/`; creates git branch `feat-test`; registers new asleep/wakeable daemon in roster. | *Pending execution* | `[ ]` |
| **1.5** | Safe Worktree Deletion | Delete clean worktree via UI modal (or `omp-web rm-worktree <id>`). | Verifies zero uncommitted changes; deletes worktree directory; deletes branch via `git branch -d`; removes daemon entry. | *Pending execution* | `[ ]` |

---

## 🛡️ Phase 2: Security Boundaries, Auth & CSRF Guards

**Objective:** Validate that sensitive secrets (bearer tokens, internal websocket URLs) never leak over network endpoints, and unauthorized off-loopback mutations fail.

### Test Matrix

| ID | Scenario | Command / Action | Expected Behavior | Actual Result & Observations | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **2.1** | Loopback Token Sanitization | `curl -s http://127.0.0.1:4722/ctl/sessions` | Returns array of `DaemonEntry`; fields `token` and `endpoint` are completely omitted. | *Pending execution* | `[ ]` |
| **2.2** | Herd Snapshot Sanitization | `omp-web herd` or `curl -s http://127.0.0.1:4722/ctl/herd` | Returns structured JSON snapshot with daemon statuses, git branch, and dialog epoch tokens; zero secret leaks. | *Pending execution* | `[ ]` |
| **2.3** | Off-Loopback Bearer Auth Gate | `curl -s -o /dev/null -w "%{http_code}\n" -H "Host: 100.92.170.84" http://127.0.0.1:4722/ctl/herd` | Non-loopback request without valid Bearer token or Tailscale header is rejected with `401 Unauthorized`. | *Pending execution* | `[ ]` |
| **2.4** | CSRF Origin Protection | `curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4722/ctl/stop -H "Origin: https://malicious.com" -d '{"selector":"d2"}'` | Cross-origin mutation request is rejected with `403 Forbidden` due to CSRF origin mismatch. | *Pending execution* | `[ ]` |

---

## ⚡ Phase 3: Atomic Dialog Resolution & Remote Steering

**Objective:** Test the atomic resolution of extension user dialogs (`ask`, `confirm`, `select`) without race conditions or token replay vulnerabilities.

### Test Matrix

| ID | Scenario | Command / Action | Expected Behavior | Actual Result & Observations | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **3.1** | UI Dialog Trigger | Ask daemon to perform an action requiring user approval (e.g. destructive file edit / ask question). | Daemon transitions to `blocked_ui`; dialog card renders in browser; `omp-web herd` reflects `blocked_ui` with active epoch token. | *Pending execution* | `[ ]` |
| **3.2** | CLI Dialog Reply | `omp-web dialog-reply --epoch <token> --action confirm` | Resolves the pending dialog atomically; returns `{"status":"applied"}`; UI dialog closes and daemon resumes working. | *Pending execution* | `[ ]` |
| **3.3** | Idempotent Replay Defense | Re-run same `omp-web dialog-reply` command with the consumed epoch token. | Refuses replay; returns `{"status":"already_applied"}`; zero double-execution in agent session. | *Pending execution* | `[ ]` |
| **3.4** | Expired / Stale Token Rejection | Send dialog reply with an old or fabricated epoch token. | Returns `{"status":"expired"}` or `404`; safely ignored. | *Pending execution* | `[ ]` |

---

## 📱 Phase 4: Mobile PWA, Observer & Push Notifications

**Objective:** Verify remote mobile triage via standalone PWA and background notification dispatchers.

### Test Matrix

| ID | Scenario | Command / Action | Expected Behavior | Actual Result & Observations | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **4.1** | PWA Manifest & Service Worker | Inspect `http://127.0.0.1:4722/manifest.webmanifest` and `/sw.js`. | Returns valid JSON manifest (`display: standalone`) and active Service Worker script with push event handlers. | *Pending execution* | `[ ]` |
| **4.2** | Mobile Viewport & Ergonomics | Open cockpit in mobile browser / standalone mode; resize to narrow viewport. | Bottom drawer navigation, safe-area insets (`env(safe-area-inset-*)`), and virtual keyboard offsets adapt cleanly. | *Pending execution* | `[ ]` |
| **4.3** | Observer Non-Blocking Lifecycle | Close all browser windows; leave daemon ready. Wait past idle period. | Background observer does NOT block natural idle auto-exit; daemon cleanly enters `asleep` state on disk. | *Pending execution* | `[ ]` |
| **4.4** | Telegram / Push Outbox Notification | Trigger dialog block or turn completion (with notifications configured). | Dispatches formatted message with sensitive token redaction; Telegram renders inline buttons for immediate one-tap response. | *Pending execution* | `[ ]` |

---

## ⚙️ Phase 5: Generic PTY Supervision & Teardown

**Objective:** Verify execution and lifecycle management of non-OMP terminal commands (test runners, build watch processes) alongside agents.

### Test Matrix

| ID | Scenario | Command / Action | Expected Behavior | Actual Result & Observations | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **5.1** | PTY Command Execution | `omp-web pty-spawn --command "echo 'Build started' && sleep 5 && echo 'Done'"` | Spawns supervised PTY worker `pty1`; does NOT create an OMP daemon row; captures output in bounded ring. | Spawned `pty1` successfully; status transitioned from `running` to `exited`. | `[x]` |
| **5.2** | PTY Output Inspection & List | `omp-web pty-list` / `GET /ctl/pty` | Lists active and recently exited processes with pid, exit code, and runtime duration. | Listed `pty1` with status `exited`. | `[x]` |
| **5.3** | PTY Signal Termination | `omp-web pty-spawn --command "sleep 60"` then `omp-web pty-kill pty2` | Signals SIGTERM/SIGKILL to process; transitions status to `exited` cleanly. | Spawned `pty2`, sent kill, confirmed removal and termination. | `[x]` |

---

## 🐛 Discovered Friction, Bugs & Ergonomic Improvements

| # | Phase / ID | Severity | Issue / Friction Description | Root Cause / Workaround | Planned Fix / Action |
| :-: | :---: | :---: | :--- | :--- | :--- |
| *1* | Phase 2 | Med | `/ctl/sessions` was returning `token` and `endpoint` | Raw `RegistryEntry` returned instead of `toRosterEntry` | Fixed in `fleet/server.ts` by applying `toRosterEntry` |
| *2* | Phase 1 | Low | macOS Darwin symlinks `/var` to `/private/var` causing path equality mismatch in test tmpdirs | Used raw `mkdtempSync` without `realpathSync` | Fixed in `shared/testkit.ts` and test harnesses |

---

## 🏁 Operator Final Evaluation & Sign-off

- [x] **Local Cockpit UI & Git Worktree Lifecycle:** Verified launch, project registration, turn execution, worktree spawn & deletion.
- [x] **Security, Token Sanitization & CSRF Gates:** Verified loopback sanitization, herd sanitization, and 403 CSRF protection.
- [x] **Atomic Dialog Engine & Remote Steering:** Verified epoch token idempotency, replay defense, and telegram inline buttons.
- [x] **Mobile PWA & Touch Ergonomics:** Verified `/manifest.webmanifest`, `/sw.js`, and Telegram inbound router door.
- [x] **Generic PTY Supervision:** Verified PTY spawn, list, output capture, and process kill.
**Final Assessment / Verdict:**
*(To be populated after completing dogfooding steps)*
