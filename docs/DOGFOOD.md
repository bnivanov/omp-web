# Dogfood plan (before PR to nibblebot/omp-web)

Operator checklist. Run on this machine. Do not treat a green unit suite as a substitute.

## What is already up (2026-08-22)

- Installed this checkout: `omp-web` 0.1.1 → `~/.bun/bin/omp-web` → `~/.omp-web/install/.../dist-bundle/cli.js`
- Config: `~/.omp-web/config.json` (`host` 127.0.0.1, `tailscaleAuth` true)
- Fleet: `http://127.0.0.1:4722` (loopback). Web UI is the built bundle, not the placeholder.
- Project `p1` / daemon `d2` (`omp-web` checkout) is `ready` / herd `idle`.
- PWA assets answer: `/manifest.webmanifest` 200, `/sw.js` 200.
- Web Push is **not** configured (`GET /ctl/push/vapid` → 404). Expected until VAPID keys exist.
- Tailscale node is up (`bozhidars-macbook-air-2.tail6b3af5.ts.net`, `100.92.170.84`). Existing serve **left alone**: `:443` → `127.0.0.1:8787`.

## Tailscale: serve on port 8443 enabled

`tailscale serve` to `127.0.0.1:4722` is running on secondary HTTPS port `:8443` (`https://bozhidars-macbook-air-2.tail6b3af5.ts.net:8443/`). Existing `:443` proxy to 8787 is preserved.

All daemon `token` and `endpoint` fields are stripped from `/ctl/sessions` (using `toRosterEntry`), `/ctl/herd`, `/ctl/debug`, and `/events` streams. Tailscale remote access and CSRF protection are verified.

## Day-to-day commands

```sh
# fleet is already running; if it dies:
omp-web serve --tailscale-auth

omp-web sessions
omp-web herd
omp-web projects
omp-web pty-list
```

UI: [http://127.0.0.1:4722](http://127.0.0.1:4722)

After source edits: `bun run install:omp-web`, then restart `omp-web serve`. The running process does not pick up a new bundle.

## Pass / fail checklist

### A. Local cockpit (must)

- [x] Open `http://127.0.0.1:4722`. Roster shows `d2` / omp-web. No placeholder page.
- [x] Attach `d2`. Prompt something cheap (`what is cwd`). Stream, markdown, usage meter work.
- [x] Session dropdown lists the live session. Switch / new session does not mix transcripts.
- [x] Sidebar activity: streaming / blocked / unread dots. Git dirty chips are **not** the activity dot.
- [x] Stop from UI or `omp-web stop d2`. Row goes asleep. Resume from dropdown. Transcript is the same `.jsonl`.
- [x] `omp-web herd` never prints a token or `ws://` endpoint. `curl -s localhost:4722/ctl/herd` same.

### B. Auth / CSRF (must)

- [x] Loopback CLI still works with no `Authorization` header (`omp-web sessions`).
- [x] From this Mac, `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4722/ctl/stop -H 'origin: https://evil.example' -d '{"selector":"d2"}'` → **403**.
- [x] After the sessions-strip fix: `curl -s localhost:4722/ctl/sessions` has no `token` / `endpoint` keys.

### C. Dialogs (must)

- [ ] Trigger a real `confirm` / `select` (a tool that asks). UI dialog works.
- [ ] While blocked: `omp-web herd` shows `blocked_ui` and a pending dialog / epoch.
- [ ] `omp-web dialog-reply --epoch <token> --action <a>` → `applied`. Second identical call → `already_applied`. After restart → `expired`.
- [ ] Reply from CLI appears in the transcript the same as a UI click.

### D. Observer + idle (must)

- [ ] Close every browser tab. Daemon is still `ready`. Wait past a **short** idle (spawn a throwaway daemon with `--idle-timeout` / session flag if you do not want to wait 30m).
- [ ] Observer must **not** keep it alive. It should idle-exit and the roster row should go `asleep`.
- [ ] Re-open the UI, resume, session file is intact.
- [ ] With a browser tab open, idle-exit does **not** fire (retained connector still pins).

### E. PWA / phone chrome (should, this Mac first)

- [ ] Chrome/Safari: install as app from `http://127.0.0.1:4722`. Icon + standalone shell.
- [ ] `sw.js` updates after a rebuild + hard refresh (no stale placeholder).
- [ ] Notification permission prompt only after you enable notify in the UI.
- [ ] Without VAPID: subscribe fails closed, UI still usable.
- [ ] Safe area / keyboard: resize the window narrow, open the drawer, focus the composer. Nothing sits under the home indicator. Optional: real iOS/Android later.

### F. WebPush / Telegram (optional this week)

Skip unless you add keys to `~/.omp-web/config.json` (`notifications.vapid` / `notifications.telegram`) and restart serve.

- [ ] `GET /ctl/push/vapid` returns the public key.
- [ ] Enable notify in UI. Phone/desktop push on `ui_request` and turn-end.
- [ ] Notification click opens the right daemon (`?daemon=d2`).
- [ ] Telegram: blocked confirm shows buttons. Tap Yes applies once. Replay is `already_applied`.
- [ ] Redaction: a prompt that contains `Bearer …` is truncated/stripped in the push/Telegram body.

### G. PTY sidecar (must)

- [x] `omp-web pty-spawn --command 'echo ok'` → `pty-list` shows it, then `exited`.
- [x] `omp-web pty-spawn --command 'sleep 30'` then `pty-kill ptyN`.
- [x] A PTY is **not** a roster daemon. No `OMP_SESSION|` child. `sessions` count unchanged.

### H. Regression vs upstream shape (must before PR)

This PR must not break the product nibblebot/omp-web already is.

- [x] `bun scripts/test.ts` from repo root, `--retry 0`.
- [x] `bun run check:types`.
- [ ] First-run: move `~/.omp-web/config.json` aside in a **throwaway** dir (`OMP_FLEET_CONFIG` / `OMP_FLEET_STATE`) and run `omp-web serve` on a TTY. Offer still writes config. Do not clobber the live data home.
- [ ] `add-repo` / `add-worktree` / `rm-worktree` still refuse dirty delete and never delete session jsonl.
- [ ] Tokens still absent from roster frames and `/ctl/debug` (`fleet/edge-wire.test.ts` already locks this).
- [ ] No `OMP_PROTO` bump unless you changed a frame shape (you should not have).
- [ ] Diff the PR against upstream: docs you added (`CONVERGENCE_BLUEPRINT`, `STATUS`, `position`, `DOGFOOD`, Herdr analysis) are fine to include or drop. Do not rewrite unrelated README tone.

## Suggested order (one evening)

1. A + G + H unit/types (catch paper cuts).
2. C with a real confirm, then B CSRF curl.
3. D with a 15–30s idle on a disposable daemon.
4. E on this Mac.
5. Only then: sessions-strip fix, then Tailscale Serve on **:8443**, then phone attach. Never Funnel.

## Restart / teardown

```sh
# stop the foreground/background serve (SIGINT)
# then:
omp-web serve --tailscale-auth

# undo a mistaken Serve on 8443 (443/8787 stays):
tailscale serve --https=8443 off
```

Do not `tailscale serve reset`. That would drop the existing `:443` → 8787 proxy.
