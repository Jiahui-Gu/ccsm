# 12 — Electron thin client

## Scope

Electron in v0.3 is a **pure thin client** to the daemon. Its main process holds zero business logic and zero authoritative state.

**Why:** final-architecture §2 principle 2 — desktop is one of three first-class clients; none is "primary". Electron-with-business-logic forces v0.4 web/iOS to either reimplement that logic (3× duplication) or extract it from Electron (= rework).

## What lives in Electron

| Concern                          | Lives in                                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| Daemon spawn / discovery         | Electron main (see [02 §lifecycle](./02-process-topology.md))           |
| Window / tray / dock / menu      | Electron main                                                            |
| Native dialogs / deep-link       | Electron main                                                            |
| Renderer (Chromium)              | xterm.js, React UI, IPC bridge to main                                   |
| Per-session in-memory snapshot cache | Electron main (renderer reload speed only)                            |
| Sentry SDK init + transport override | Electron main + renderer (transport calls Connect `CrashService.Report`) |

## What does NOT live in Electron (moved to daemon)

- PTY child management → daemon (see [09](./09-pty-host.md))
- Session state authority → daemon (see [08](./08-session-model.md))
- SQLite → daemon (see [10](./10-sqlite-and-db-rpc.md))
- Crash uploading → daemon (see [11](./11-crash-and-observability.md))
- Notification fan-out → daemon (existing `electron/notify/` business logic moves to daemon-side fan-out hooked into session events; the Electron-side stays as a thin OS-notification displayer)
- Session title generation, session watcher, claude-agent-sdk subprocess, cwd state → daemon

The corresponding Electron source dirs (`electron/ptyHost/`, `electron/sessionWatcher/`, `electron/sessionTitles/`, `electron/notify/bootstrap/`, plus the `electron/daemonClient/` envelope plumbing) are deleted — see [14](./14-deletion-list.md).

## Connect-RPC client

- Library: `@connectrpc/connect-node` (Electron main runs Node, so `connect-node` is correct; **not** `connect-web`).
- Transport: HTTP/2 over the UDS / named pipe of Listener A. `connect-node` supports custom transport via the `createConnectTransport` factory.
- Imports generated stubs from `proto/gen/ts/`.

The same generated stubs are consumed by web (v0.4, via `@connectrpc/connect-web`) and Swift (v0.4). Electron's only difference is the transport choice (UDS vs HTTPS).

## Spawn-or-discover daemon (electron-main boot flow)

```
1. Read discovery.json (see chapter 03 §address discovery).
2. If exists and supervisor /healthz returns ok → connect Connect client to listenerA.path.
3. Else → spawn detached daemon (see chapter 02 §spawn path), wait up to 10s for healthz, then proceed.
4. Call daemon.hello (over supervisor envelope) → cache bootNonce.
5. Initialize Connect client against Listener A.
6. Spawn renderer windows.
```

## Per-session snapshot cache (renderer reload speed)

Electron main keeps a `Map<sessionId, { snapshot, lastSeq }>` updated by the Connect `pty.Subscribe` stream. When renderer is reloaded:

- Renderer asks main (via IPC) for the cached snapshot for the session it's restoring.
- Main returns it instantly (no daemon round-trip).
- Renderer then resubscribes on its own (via IPC bridge → main → Connect) using `from_seq = lastSeq` so deltas stream from the last cached point.

This is the **only** state the main process keeps. It is purely a performance cache; the daemon's authoritative state is the source of truth.

## bootNonce-based reconnect

- On any Connect transport error (daemon crash, supervisor socket closed):
  - Main re-runs spawn-or-discover.
  - On re-`daemon.hello`, compares new bootNonce with cached.
  - If changed: invalidate snapshot cache; resubscribe sessions with `from_seq` undefined (forces snapshot).
  - If same: resubscribe with `from_seq = lastSeq` (delta-only resume).

This is the v0.3 frag-3.7 reconnect logic, simplified by removing HMAC + boot-nonce-precedence.

## Renderer → main IPC bridge

- Renderer cannot directly reach the Connect client (separate process). Renderer talks to main via the existing preload bridge (`electron/preload/bridges/`).
- Bridge methods are 1:1 with the Connect surface where renderer needs them (e.g., `bridge.pty.input(sessionId, bytes)` → main → Connect `pty.Input`).
- Streams are forwarded via `webContents.send` per-frame.

This bridge layer is thin (forwarding only) and lives in `electron/preload/bridges/connect-bridge.ts`. It is NOT business logic.

## Renderer kill / main kill survives daemon (the v0.3 dogfood proof)

This is the v0.3 ship-gate integration test, mandated by reconciliation #75:

| Test                                         | Expected                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| Kill renderer (Cmd-R / SIGKILL renderer pid) | Renderer reloads, snapshot served from main cache, deltas resume |
| Kill main (SIGKILL main pid)                 | Daemon survives; on Electron relaunch, sessions are still there, snapshots served from daemon (cache is cold) |
| `daemon.shutdown` then immediate restart     | Sessions PTY children persist? → **No**, they die with daemon (current scope; persistence is v0.5). Sessions metadata persists; new daemon shows them as `closed` |

The middle row is THE proof that daemon-detached-from-Electron is real.

## Electron version pin + ABI

- Existing v0.3 frag-11 Electron exact-pin (33.x) survives.
- Electron's bundled Node (Electron 33 = Node 22) matches daemon's bundled Node, so native modules used by both (e.g., `ccsm_native` if Electron loaded it — it doesn't in v0.3 because peer-cred is daemon-side) would be ABI-compatible. v0.3 actually does not load `ccsm_native` in Electron at all.

## What the renderer ships

- xterm.js for terminal rendering.
- React UI (existing components, only the data sources change — pull from main IPC bridge instead of from Electron-side SQLite).
- No direct daemon-touching code.

## Cross-refs

- [01 — Goals (G6)](./01-goals-and-non-goals.md)
- [02 — Process topology (spawn / discovery)](./02-process-topology.md)
- [03 — Listener A (Connect-Node UDS / pipe transport)](./03-listener-A-peer-cred.md)
- [05 — Supervisor control plane (daemon.hello + bootNonce)](./05-supervisor-control-plane.md)
- [06 — Proto (generated stubs consumed)](./06-proto-schema.md)
- [08 — Session model (subscribe / from_seq / bootNonce)](./08-session-model.md)
- [11 — Crash + observability (Sentry transport override)](./11-crash-and-observability.md)
- [14 — Deletion list (electron/daemonClient/* deleted; ptyHost/sessionWatcher/etc. moved)](./14-deletion-list.md)
- [15 — Testing strategy (kill-renderer / kill-main IT)](./15-testing-strategy.md)
