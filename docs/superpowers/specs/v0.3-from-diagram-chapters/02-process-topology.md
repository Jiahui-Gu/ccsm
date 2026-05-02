# 02 — Process topology

## Diagram (v0.3 slice of final architecture)

The v0.3 process layout is the bottom half of the final-architecture diagram, with cloudflared / web / iOS struck out. Reproduced (copied verbatim from `../2026-05-02-final-architecture.md` §1, with NOT-YET-PRESENT components annotated):

```
   ╔════════════════════════════ user's local machine ════════════════════════════╗
   ║                                                                              ║
   ║   ┌───────────────────────────┐                                              ║
   ║   │  cloudflared (sidecar)    │  ◀── NOT IN v0.3. Listener B has no consumer ║
   ║   │  - tunnel client          │      until v0.4. Listener B still bound.     ║
   ║   │  - HTTP/2 only            │                                              ║
   ║   └───────────────┬───────────┘                                              ║
   ║                   │  127.0.0.1:PORT_TUNNEL  (Connect-RPC, JWT required)      ║
   ║                   ▼                                                          ║
   ║   ┌──────────────────────────────────────────────────────────────────────┐   ║
   ║   │  ccsm-daemon  (single binary, backend-authoritative)                 │   ║
   ║   │                                                                      │   ║
   ║   │   ┌─────────── data plane ───────────┐  ┌── control plane ──┐        │   ║
   ║   │   │  Listener A: loopback / UDS      │  │  Supervisor UDS   │        │   ║
   ║   │   │    (peer-cred, JWT bypass)       │  │  (v0.3 envelope)  │        │   ║
   ║   │   │  Listener B: 127.0.0.1:PORT_TUN  │  │  /healthz, hello, │        │   ║
   ║   │   │    (CF Access JWT validated;     │  │  shutdown*        │        │   ║
   ║   │   │     cloudflared-only consumer)   │  └───────────────────┘        │   ║
   ║   │   └────────────────┬─────────────────┘                                │   ║
   ║   │                    │                                                  │   ║
   ║   │       Connect-RPC over HTTP/2 (proto-generated surface)               │   ║
   ║   │                                                                      │   ║
   ║   │   Session manager · PTY host (xterm-headless, snapshot+delta) ·      │   ║
   ║   │   claude CLI subprocess · SQLite · cwd state · crash collector       │   ║
   ║   └──────────────────────────┬───────────────────────────────────────────┘   ║
   ║                              │                                               ║
   ║                              │ Listener A                                    ║
   ║                              ▼                                               ║
   ║   ┌──────────────────────────────────────┐                                   ║
   ║   │  Desktop client (same machine)       │                                   ║
   ║   │  - Connect client (proto-generated)  │                                   ║
   ║   │  - hits Listener A directly          │                                   ║
   ║   └──────────────────────────────────────┘                                   ║
   ║                                                                              ║
   ╚══════════════════════════════════════════════════════════════════════════════╝
```

## Processes present in v0.3

| Process            | Binary                                | Lifecycle                                                                           | Children                              |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| `ccsm-daemon`      | single packaged Node 22 binary        | OS-supervised intent (see G4); v0.3 in practice: spawn-on-demand by Electron main, **detached**; survives Electron exit | `claude` CLI subprocesses (per session), PTY children |
| Electron main      | Electron app                          | User-driven (open/quit)                                                             | Renderer (Chromium) processes         |
| Electron renderer  | Chromium                              | Spawned by main                                                                     | none                                  |

## Process not present in v0.3 (placeholder only)

- `cloudflared` — final-architecture has it as a daemon child. v0.3 does NOT spawn it. v0.3 daemon contains **no** sidecar lifecycle module, no spawn helper, no "if (cloudflaredEnabled)" branch. The `daemon.SetRemoteEnabled` Connect method exists in `proto/` (per [06](./06-proto-schema.md)) but its v0.3 server-side implementation MUST return `Unimplemented` (see [07](./07-connect-server.md) §"Stubbed methods"). **Why deferred (v0.4):** sidecar binary distribution + auto-update is its own supply-chain workstream.

## Daemon lifecycle (G4 — OS-supervisor-ready)

**Decision:** Daemon process MUST be detached from Electron at spawn time. Daemon MUST NOT die when Electron dies.

### v0.3 spawn path (interim until OS supervisor lands)

When Electron main starts and finds no live daemon (per lockfile + `/healthz` ping):

1. Electron resolves the daemon binary path (packaged-resource location, see [13](./13-packaging-and-release.md)).
2. Electron spawns the daemon with `child_process.spawn(daemonPath, [...args], { detached: true, stdio: 'ignore', windowsHide: true })`.
3. Electron immediately calls `child.unref()`. The daemon is no longer a node-side child of Electron.
4. Electron writes nothing to stdin and never reads stdout/stderr. Daemon owns its own pino logs to disk.
5. On Windows, `detached: true` puts the daemon in a new process group (no console). The daemon installs no SIGINT-on-parent-exit hook.
6. Electron polls `/healthz` over the supervisor socket until ready (or 10 s timeout → user-facing error dialog).

When Electron main exits:

- Daemon MUST stay alive. Verified by integration test: kill Electron main with SIGKILL, observe daemon `/healthz` continues to respond and any active session continues to receive PTY output. See [15 §IT-3](./15-testing-strategy.md).

### v0.3 daemon-discovery path

When Electron main starts and **does** find a live daemon (lockfile + `/healthz` ping succeed):

- Electron does NOT spawn a second daemon.
- Electron connects its Connect client to Listener A (path read from the lockfile / discovery file — see [03](./03-listener-A-peer-cred.md) §"Address discovery").
- Electron treats the daemon as a peer it found, not a child it owns.

### v0.3 daemon shutdown

The daemon shuts down on receipt of `daemon.shutdown` or `daemon.shutdownForUpgrade` over the supervisor envelope (see [05](./05-supervisor-control-plane.md)). The Electron app does NOT trigger `daemon.shutdown` automatically on quit — quitting the app leaves the daemon running. Explicit "Quit Daemon" is a user-initiated menu item (or upgrade orchestration). This is final-architecture principle 9 made literal.

**Why:** if v0.3 ever auto-stops the daemon on Electron quit, then v0.4 web/iOS users (who have no Electron) lose service when desktop is closed. Auto-stop = v0.4 rework.

### v0.3 crash recovery (without OS supervisor)

In v0.3 there is no OS service unit yet. If the daemon crashes, **Electron MAY respawn it** via the same detached-spawn path on next user action that requires the daemon (e.g. opening a session). This is acceptable for v0.3 because:

- The desktop user is the only consumer; if Electron is closed and daemon crashed, no one notices until user reopens Electron.
- No web/iOS client exists in v0.3 that would lose service silently.

In v0.4 the OS supervisor takes over respawn; the Electron-side respawn becomes a redundant (but harmless) fallback. **No code in the v0.3 Electron-side respawn path is removed in v0.4** — it stays as belt-and-suspenders.

**Why deferred (v0.4):** OS unit installation (launchd plist / systemd-user unit / Windows Service registration) is per-OS packaging work and gates on cloudflared distribution.

## Address discovery: Electron → Listener A

Daemon writes a single discovery file at a fixed location (see [03 §"Address discovery"](./03-listener-A-peer-cred.md) for path policy). Electron reads it. No env vars, no flag-based override, no fallback ports. Single source of truth.

The discovery file also contains Listener B's port (so external tools / future cloudflared can find it). Electron does not connect to Listener B.

## Worktree / dev-loop concerns

- Multiple checkouts of the repo MUST get distinct daemon socket paths (existing `socket cwd hash isolation` work, task #68). Discovery file path includes a cwd-hash component. See [03 §"Address discovery"](./03-listener-A-peer-cred.md).
- Dev hot-reload of the daemon (nodemon-style) MUST cleanly close listeners before respawn. Dev-mode "do not detach" is acceptable (`CCSM_DAEMON_DEV=1`) but production builds MUST detach.

## Cross-refs

- [01 — Goals (G4)](./01-goals-and-non-goals.md)
- [03 — Listener A](./03-listener-A-peer-cred.md)
- [04 — Listener B](./04-listener-B-jwt.md)
- [05 — Supervisor control plane](./05-supervisor-control-plane.md)
- [12 — Electron thin client (spawn / discovery / kill-survives test)](./12-electron-thin-client.md)
- [13 — Packaging](./13-packaging-and-release.md)
