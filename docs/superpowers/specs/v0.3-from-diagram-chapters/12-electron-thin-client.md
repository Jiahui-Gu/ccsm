# 12 — Electron thin client

> Authority: [final-architecture §2.4](../2026-05-02-final-architecture.md#2-locked-principles) (desktop on the same machine → Listener A), §2.7 (clients are pure subscribers), §2.9 (closing the desktop client does not stop the daemon).

## Posture

In v0.3 Electron is the **only** v0.3 client and a **pure thin client**. Its responsibilities:

- Render the UI (renderer: React or whatever the existing v0.2 stack is — no rewrite required).
- Speak Connect over Listener A (UDS / named pipe) using `@connectrpc/connect-node`'s UDS HTTP/2 transport in main, IPC-bridged to renderer.
- Bootstrap the daemon ([02 L1](./02-process-topology.md#lifecycle-rules-v03)) — spawn detached if not already running.
- OS chrome: window management, menu bar, dock/tray, file dialogs, deep links (`ccsm://`).

That is all. Electron has **no**:
- `node-pty` import (PTY is in daemon — [ch.09](./09-pty-host.md)).
- `better-sqlite3` import (DB is in daemon — [ch.10](./10-sqlite-and-db-rpc.md)).
- Session manager (server-side — [ch.08](./08-session-model.md)).
- Envelope client (data plane is Connect — [ch.06](./06-proto-schema.md)).
- Hello-HMAC code (removed — [ch.05](./05-supervisor-control-plane.md)).

## File layout (changes from v0.2)

```
electron/
├── main/
│   ├── index.ts                  (boot: ensure daemon running, attach Connect)
│   ├── daemon-bootstrap.ts       (probe Listener A; if dead, spawn detached)
│   ├── connect-client.ts         (constructs UDS HTTP/2 Connect transport, exports typed clients)
│   └── ipc-bridge.ts             (forwards renderer requests → Connect, streams back)
├── preload/
│   └── index.ts                  (typed preload API for renderer; mirrors proto services)
└── renderer/
    └── ... (existing UI; sole change: data hooks call preload API instead of in-renderer state)
```

## Renderer ↔ main bridge

The renderer never imports `@connectrpc/connect-node` (Node-only). The preload exposes a typed mirror of each Connect service; main forwards to the daemon's Connect server and streams responses back via `MessagePort` (zero-copy for binary frames) or `ipcRenderer` events (for non-streaming). **Why:** Electron security (renderer should not have Node access); the alternative — running Connect-Web in renderer pointed at a TCP loopback — would force a TCP Listener A and break peer-cred ([ch.03](./03-listener-A-peer-cred.md)).

## Bootstrap sequence

1. App launch → `daemon-bootstrap.ts` opens UDS connection to Listener A path.
2. If connect succeeds: `ControlService.ServerInfo` → confirm version match, proceed.
3. If connect fails (ENOENT / ECONNREFUSED): spawn `ccsm-daemon` with `{detached:true, stdio:'ignore'}` + `unref()`.
4. Poll Listener A for up to N seconds; on success, proceed; on timeout, surface error UI.
5. Subscribe to `supervisor.event` (separate UDS — [ch.05](./05-supervisor-control-plane.md)) for lifecycle notifications.

## Lifecycle decoupling (verified by IT)

The integration test suite ([ch.15](./15-testing-strategy.md)) MUST include:

- IT-E1: kill renderer → main re-spawns renderer; daemon and PTY untouched; new renderer reattaches and resumes streaming.
- IT-E2: kill main (whole Electron app) → daemon process still alive; relaunch Electron; reattaches; existing PTY children still emitting.
- IT-E3: kill daemon → PTY children die; relaunch daemon (manually in test, by Electron in real life); sessions marked `interrupted`; clients see `FailedPrecondition` on existing Subscribes.

## Forbidden

- Any business logic in renderer that holds session truth.
- Any direct PTY/SQLite import.
- Any "main as daemon proxy that does mutation" — main is a transport-bridge only.
- Bypassing Connect for "small" things (e.g. reading SQLite directly because "it's just a setting"). **Why:** §2.1, §2.7.

## §12.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无 (with 一个 reviewer-flagged caveat — 见下)。Electron thin client 走 Listener A, preload-bridge 暴露 typed proto API, 业务在 daemon — v0.4 desktop 同一形态。v0.4 client UX spec ([final-architecture §4](../2026-05-02-final-architecture.md#4-subordinate-specs-placeholders)) 提到"desktop tech choice (Tauri vs Electron-port)"是 open question; 若 v0.4 选 Tauri, 这是**整体替换** Electron 而非**修改** v0.3 Electron 代码 — v0.3 Electron 代码作为已 ship 的旧客户端要么并存要么淘汰, 不被 in-place 修改, 仍满足零返工。Reviewer 应在 [§16](./16-risks-and-open-questions.md) 复核此措辞是否成立; 若 Tauri 切换被视为"返工", 本章需重新设计为 Tauri-from-day-1。

## Cross-refs

- [03-listener-A-peer-cred](./03-listener-A-peer-cred.md) — sole transport.
- [06-proto-schema](./06-proto-schema.md) — generated client used in `connect-client.ts`.
- [14-deletion-list](./14-deletion-list.md) — files removed from electron/.
- [15-testing-strategy](./15-testing-strategy.md) — IT-E1..E3.
