# omp-web position

omp-web is the **fleet cockpit** for oh-my-pi: one installed command, one browser UI, N disposable `omp-session` daemons (one cwd each), plus a loopback/remote control plane.

It is not a terminal emulator, not a TUI skin, and not a replacement for the omp TUI or for `omp-gui`.

## What it owns

- **SDK-native session control.** `omp-session` hosts `createAgentSession` in-process and speaks HTTP + SSE (`OMP_PROTO` 2). Structured `ui_request` / `ui_response`, subagent trees, history reload, and `/download` jail are first-class. Heuristic screen scraping is not the dialog path.
- **Zero-agent-state fleet.** `omp-fleet` persists roster metadata only. Agent truth lives in each daemon and its `.jsonl`. Daemons idle-exit and resume from disk.
- **Remote and mobile ingress.** Operator auth (bearer or Tailscale identity) + CSRF on mutating fleet HTTP. Optional WebPush and Telegram for `ui_request` / turn-end. PWA install + `notificationclick` deep links. `/ctl/herd` is the bot-friendly snapshot; SSE remains the event source.
- **Worktrees and fan-out.** Register projects, create or adopt managed worktrees, spawn/stop/resume, prompt many daemons by selector.

## What it is not

- **Not `omp-gui`.** [can1357/oh-my-pi `omp2/crates/gui`](https://github.com/can1357/oh-my-pi/tree/omp2/crates/gui) hosts `omp-tui` cell grids in a native wgpu window. The published chat example is a mock backend. The browser example composites `omp-webview` pixels. That is a local TUI host, not a multi-daemon control plane.
- **Not Herdr.** Herdr supervises arbitrary PTYs over a Unix socket. omp-web's PTY supervisor is a fleet-side sidecar for non-OMP commands. Agent sessions stay SDK daemons.
- **Not the TUI.** Collab rooms stay CLI/TUI. The web UI has no collab surface by design.

Composition later (embed the web UI in `omp-webview`, share chat widgets) is fine. Substitution is not: a native window cannot attach a tailnet daemon, answer a blocked confirm from Telegram, or fan a prompt across `dN`.

## Security posture (fleet)

- Default bind is loopback (`127.0.0.1`). Binding a non-loopback host requires `--token` / `OMP_FLEET_TOKEN` or `--tailscale-auth`.
- Off-loopback callers need that bearer or a Tailscale-User-Login from Tailscale CGNAT (`100.64/10`).
- Mutating requests from a browser Origin need CSRF (`x-omp-csrf` matching the token, same-origin, or loopback-to-loopback Origin for the vite proxy). CLI POSTs with no Origin stay allowed on loopback.
- `/ctl/herd`, roster frames, and `/ctl/debug` never serialize daemon tokens or endpoints.
