# 08 — Electron Client Migration

v0.3 ship-gate (a) requires zero `contextBridge` / `ipcMain` / `ipcRenderer` references in `packages/electron/src` (brief §11(a)). This chapter inventories every existing Electron IPC surface, maps each to a Connect call against Listener A using the proto from [04](./04-proto-and-rpc-surface.md), and pins the big-bang cutover plan, the dead-code removal procedure, and the verification harness. Migration is one PR (sequenced behind the daemon-side RPC PRs); incremental coexistence is forbidden.

### 1. Migration philosophy: big-bang, single PR

Brief §3 says **big-bang**. Why not incremental:

- Coexistence (some calls IPC, some Connect) demands two state-sync paths, two error models, and two test paths — exactly the rework the zero-rework rule forbids.
- The Electron renderer's React tree treats all data as coming from one provider; introducing a second source mid-tree requires plumbing flags everywhere.
- A clean cutover lets us delete `contextBridge`/`ipcMain` files entirely, which makes ship-gate (a) a `git rm` + `grep` rather than a partial-deletion audit.

The cutover PR is large but mechanically reviewable: every IPC call is replaced by a Connect call with a 1:1 mapping table (§3 below).

### 2. Existing IPC surface inventory

The following table is the v0.3 starting state — every `ipcMain.handle` registration in the existing Electron app and every `contextBridge.exposeInMainWorld` API. This list MUST be re-verified by `grep -rn "ipcMain.handle\|contextBridge.exposeInMainWorld" packages/electron/src` against the actual code at the moment the migration PR is opened; any addition since this spec was written MUST be added to the mapping in §3 before the PR merges.

| Existing IPC channel | Direction | Purpose | Lives in |
| --- | --- | --- | --- |
| `session:list` | renderer → main | list sessions | main process session manager |
| `session:get` | renderer → main | fetch one session | main |
| `session:create` | renderer → main | spawn claude + PTY | main |
| `session:destroy` | renderer → main | kill session | main |
| `session:event` | main → renderer (push) | session list change events | main |
| `pty:attach` | renderer → main | begin streaming PTY data | main |
| `pty:data` | main → renderer (push) | PTY output bytes | main |
| `pty:input` | renderer → main | keystroke input | main |
| `pty:resize` | renderer → main | terminal resize | main |
| `crash:list` | renderer → main | get crash log | main |
| `crash:event` | main → renderer (push) | new crash entry | main |
| `settings:get` | renderer → main | read settings | main |
| `settings:set` | renderer → main | write settings | main |
| `app:version` | renderer → main | get app version string | main |
| `app:open-external` | renderer → main | OS shell open URL | main (Electron `shell.openExternal`) |

### 3. IPC → Connect mapping

| IPC | Replaced by |
| --- | --- |
| `session:list` | `SessionService.ListSessions` (unary) |
| `session:get` | `SessionService.GetSession` (unary) |
| `session:create` | `SessionService.CreateSession` (unary) |
| `session:destroy` | `SessionService.DestroySession` (unary) |
| `session:event` | `SessionService.WatchSessions` (server-stream); renderer subscribes once on app boot |
| `pty:attach` + `pty:data` | `PtyService.Attach` (server-stream returning `PtyFrame`); one stream per attached session |
| `pty:input` | `PtyService.SendInput` (unary) |
| `pty:resize` | `PtyService.Resize` (unary) |
| `crash:list` | `CrashService.GetCrashLog` (unary) |
| `crash:event` | `CrashService.WatchCrashLog` (server-stream) |
| `settings:get` | `SettingsService.GetSettings` (unary) |
| `settings:set` | `SettingsService.UpdateSettings` (unary) |
| `app:version` | **renderer-only**: bundled at build time as `import.meta.env.APP_VERSION`; no IPC, no RPC |
| `app:open-external` | **renderer-only**: standard browser `window.open(url, '_blank')` for `https?://`; reject other schemes; no Electron `shell` |

`app:version` and `app:open-external` are the only two that move into the renderer process directly rather than to the daemon. **Why**: they are pure-UI concerns the daemon should not know about. v0.4 web client gets `app:version` from its own bundle and `open-external` from browser-native `window.open`; iOS gets both from native APIs. Symmetric across clients.

> If any new IPC is found during migration that does NOT fit into one of the existing services, the migration PR MUST add the corresponding RPC to proto + daemon BEFORE merging the Electron change. New RPCs follow the additivity contract from [04](./04-proto-and-rpc-surface.md) §8 — this is a v0.3 first-ship addition, not a v0.4 add.

### 4. Electron process model post-migration

<!-- F2: closes R0 08-P0.2 / R0 08-P0.3 / R2 P0-08-1 / R2 P0-08-2 — bootstrap mechanism is descriptor-handshake-by-fetch (no contextBridge); transport bridge ships unconditionally; DNS rebinding mitigated by bridge bound to UDS / named pipe (no loopback TCP for bridge↔daemon); descriptor authenticity via Hello-echo of boot_id. -->

```
electron main process (minimal):
  - BrowserWindow lifecycle (create/show/close)
  - reads listener-a.json (chapter [03](./03-listeners-and-transport.md) §3) at app start; pins
    descriptor + boot_id for the renderer's session
  - hosts the renderer transport bridge (see §4.2 below) — ships unconditionally in v0.3
  - registers a custom scheme handler via protocol.handle so the renderer can
    fetch app://ccsm/listener-descriptor.json and read the (validated) descriptor
    without contextBridge / additionalArguments
  - NO ipcMain.handle calls
  - NO business logic
  - tray menu (quit / open settings) — UI, no IPC

electron preload (minimal — no contextBridge):
  - intentionally empty (or omitted entirely); the descriptor reaches the
    renderer via the app:// scheme, NOT via injection
  - NO contextBridge.exposeInMainWorld for callable APIs OR for data
  - sandbox: true; nodeIntegration: false; contextIsolation: true on every BrowserWindow

electron renderer:
  - on boot, fetch("app://ccsm/listener-descriptor.json") → parse → construct Connect
    transport pointed at the bridge (see §4.2)
  - immediately calls Hello and verifies boot_id echoes the descriptor's boot_id
    (chapter [03](./03-listeners-and-transport.md) §3.3); rejects + retries on mismatch
  - wraps the proto-generated SessionService/PtyService/... clients in React Query / TanStack Query hooks
  - all UI state comes from RPC results
```

#### 4.1 Bootstrap mechanism (locked: descriptor served via `protocol.handle`, no `contextBridge`)

R0 08-P0.2 flagged that `webPreferences.additionalArguments` does NOT inject onto `window` under context isolation — `additionalArguments` only appends to the renderer's `process.argv`, which is invisible from the renderer's window scope. The naive fix (`contextBridge.exposeInMainWorld`) trips ship-gate (a). The locked v0.3 mechanism avoids both:

1. Electron main reads `listener-a.json` from the locked per-OS path (chapter [07](./07-data-and-state.md) §2 / chapter [03](./03-listeners-and-transport.md) §3) at app start.
2. Electron main rewrites the descriptor's `address` field to point at the bridge's loopback endpoint (§4.2) — the renderer never sees the daemon's UDS / named pipe path because the renderer never speaks to it directly.
3. Electron main registers a custom scheme handler via `protocol.handle("app", ...)` that serves the rewritten descriptor at `app://ccsm/listener-descriptor.json` (read-only; `Content-Type: application/json`).
4. Renderer at boot calls `await fetch("app://ccsm/listener-descriptor.json")` and parses the result. No `contextBridge`, no `additionalArguments`, no preload-injected globals — `lint:no-ipc` (§5h.1) passes mechanically.
5. Renderer constructs the Connect transport from the descriptor and runs the `Hello`-echo `boot_id` verification (chapter [03](./03-listeners-and-transport.md) §3.3) before any other RPC. The bridge forwards `Hello` to the daemon and the daemon's in-memory `boot_id` reaches the renderer untouched.

#### 4.2 Renderer transport bridge — ships unconditionally in v0.3

**Decision (locked, no spike outcome required)**: the Electron main process hosts a transport bridge for the renderer; v0.3 ships this bridge **unconditionally** on every OS. The bridge is `packages/electron/src/main/transport-bridge.ts`.

**Why ship unconditionally (R5 P1-14-2 + R0 08-P0.3 resolution)**:

1. **Predictability across OS** — Chromium fetch cannot use UDS or named pipes anywhere; loopback TCP works but the daemon's chosen Listener A transport may be UDS or named pipe per OS. Shipping the bridge eliminates the per-OS conditional in the renderer.
2. **Avoids Electron renderer-side gotchas** — `additionalArguments` doesn't hit `window` under context isolation; preload `contextBridge` trips `lint:no-ipc`; `protocol.handle` only serves data, not full Connect framing. The bridge sidesteps every one of these.
3. **Zero-rework for v0.4** — the v0.4 web client uses `connect-web` directly (browser → cloudflared → Listener B); v0.4 iOS uses `connect-swift` directly (iOS → cloudflared → Listener B). NEITHER goes through the Electron transport bridge — they don't even ship the Electron renderer code. So the bridge is forever Electron-internal; v0.4 never modifies it. Chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern locks this: "v0.4 MUST NOT modify `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons; web/iOS do not use it."

**Bridge shape**:

- Renderer ↔ bridge: `http2` server on `127.0.0.1:<ephemeral-port>` bound on `127.0.0.1` only (no `0.0.0.0`); `Host:` header MUST equal `127.0.0.1:<our-port>` (anything else → 421 Misdirected Request — closes the structural part of R2 P0-08-1 / R2 P0-03-1 DNS-rebinding hole at the bridge layer; per-request `Host:` allowlist enforcement is restated here, the deeper bearer-token belt-and-suspenders is deferred to v0.4 per dispatch plan §0).
- Bridge ↔ daemon: speaks the daemon's chosen Listener A transport (UDS / named pipe / loopback TCP / loopback TLS — whichever was negotiated). For UDS / named pipe, the bridge is the ONLY caller across the OS-level socket; the renderer never touches it. This means the bridge sits "around" the otherwise UDS-protected daemon BUT ONLY exposes loopback TCP to the renderer (which is the only way Chromium can speak Connect).
- The bridge is NOT an IPC re-introduction (it speaks Connect, same proto, no `ipcMain.handle`); ship-gate (a) grep still passes.
- Bridge process identity: the bridge runs in Electron main, so the daemon's peer-cred sees the Electron main process's uid (== the logged-in user). Correct attribution for v0.3 single-user.

### 5. Cutover sequence (single PR)

1. (Pre-PR) Daemon-side PRs land: every RPC in [04](./04-proto-and-rpc-surface.md) is implemented and tested behind a feature-flag-gated daemon binary. Connection descriptor is written. Listener A binds. Integration tests against the daemon pass.
2. (PR) The Electron migration PR:
   a. Add `packages/electron/src/rpc/clients.ts` constructing typed clients from the descriptor.
   b. Add `packages/electron/src/rpc/queries.ts` wrapping each in React Query hooks.
   c. Replace every existing `ipcRenderer.invoke(...)` and `ipcRenderer.on(...)` site with the corresponding hook (mechanical 1:1).
   d. Delete `packages/electron/src/main/ipc/` directory.
   e. Delete `packages/electron/src/preload/contextBridge.ts`.
   f. Replace preload with an empty (or omitted) file; the descriptor reaches the renderer via `protocol.handle("app", ...)` per §4.1, NOT via injection.
   g. Update `packages/electron/src/main/index.ts` to remove all `ipcMain.handle` registrations, register `protocol.handle("app", ...)` for the descriptor (§4.1), spin up the transport bridge (§4.2), and spawn a tray menu only.
   h. Add the `npm run lint:no-ipc` script per §5h.1 (canonical specification below).
   i. Wire the script into CI (see [12](./12-testing-strategy.md) §3).
3. (Post-merge) E2E test (ship-gate (a)/(b)/(c)) runs in CI nightly and on every release tag.

#### 5h.1 `lint:no-ipc` canonical specification (single source of truth, this chapter)

<!-- F2: closes R5 P0-08-1 / R0 P0-08-1 / R4 P0 ch 08 / ch 12 — chapter 08 specifies; chapter 12 implements; brief references this section. -->

This chapter specifies the v0.3 canonical form of the `lint:no-ipc` ship-gate. Any divergence in 00-brief.md or chapter [12](./12-testing-strategy.md) is a documentation bug — chapter 08 §5h.1 is the source of truth. Chapter [12](./12-testing-strategy.md) §3 implements the actual ESLint config + CI wiring; this section pins WHAT must be forbidden:

**Forbidden patterns (rejecting any one of these blocks the PR)**:

1. `import { ipcMain | ipcRenderer | contextBridge } from "electron"` — any named import of these three symbols from the `electron` package, in any source file under `packages/electron/src/`.
2. `require("electron").ipcMain` / `require("electron").ipcRenderer` / `require("electron").contextBridge` — destructuring or property access on the dynamically-required `electron` module.
3. Any method call shaped `.send(` / `.handle(` / `.on(` / `.invoke(` / `.handleOnce(` invoked on a symbol whose value flows from one of the forbidden Electron imports above (caught by ESLint `no-restricted-properties` + a custom rule `ccsm/no-electron-ipc-call` that performs intra-file constant-tracking; full rule body lives in chapter [11](./11-monorepo-layout.md) §5).
4. Any usage of `webContents.send`, `webContents.executeJavaScript`, `MessageChannelMain`, `MessagePortMain`, or `process.parentPort` outside `packages/electron/src/main/transport-bridge.ts` (the only sanctioned non-Connect main↔renderer surface; see §4.2). The bridge is exempt because it speaks Connect framing, not IPC.

**Allowlist**: NONE in v0.3. The descriptor injection mechanism uses `protocol.handle` (§4.1), which is not on the forbidden-pattern list — no allowlist entry is needed for it.

**Implementation reference**: chapter [12](./12-testing-strategy.md) §3 ships the actual ESLint config + the `tools/lint-no-ipc.sh` driver script + the CI wiring; chapter 08 §5h.1 is the spec.

### 6. Renderer error-handling contract

- Every RPC may fail with `UNAVAILABLE` (daemon restarting); UI shows a non-blocking banner "Reconnecting..." and the underlying React Query retries with backoff.
- `PERMISSION_DENIED` is treated as a programming error (the only principal in v0.3 is `local-user`; ownership mismatch should not happen on a single-user machine). UI shows an error toast and logs to console; UX is "should be impossible".
- `FAILED_PRECONDITION` from `Hello` (version mismatch) shows a blocking modal "Daemon version X is incompatible with this Electron build (min Y). Please update.".
- Stream errors (`Attach`, `WatchSessions`, `WatchCrashLog`) trigger automatic reattach with exponential backoff capped at 30s. Reattach uses the recorded last-applied seq for `Attach`.

### 7. Verification harness (ship-gate (a) and (b))

- Static (gate (a)): the `lint:no-ipc` script in CI; blocks merge.
- Runtime (gate (b)): an E2E test that:
  1. Starts daemon (in CI: in-process; in nightly: service-installed VM).
  2. Launches Electron in test mode, creates 3 sessions, waits for `RUNNING`.
  3. Records each session's last applied PTY seq.
  4. SIGKILLs the Electron main PID.
  5. Verifies daemon is still up via Supervisor `/healthz`.
  6. Verifies each session's `claude` CLI subprocess is still alive.
  7. Relaunches Electron; waits for connect; verifies the 3 sessions appear; reattaches each; asserts `Attach` returns deltas continuing from the recorded seq (no gap, no duplicate).

### 8. v0.4 delta

- **Add** new RPCs as needed; the renderer's clients factory automatically picks them up from regenerated proto stubs. Existing call sites: unchanged.
- **Add** new UI for v0.4 features (tunnel toggle, principal switcher) by composing additional React Query hooks against new RPCs.
- **Web/iOS clients DO NOT use the transport bridge** (§4.2): they speak `connect-web` / `connect-swift` directly to Listener B over cloudflared. The bridge is forever Electron-internal; chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern locks "v0.4 MUST NOT modify `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons."
- **Unchanged**: every existing call site, the `protocol.handle` descriptor injection mechanism (§4.1), the `lint:no-ipc` rule (still gates merge in v0.4 too — chapter 08 §5h.1 is forever-stable), the error contract, the cutover-style migration philosophy (v0.4 web/iOS clients are net-new packages, not migrations), the descriptor schema (additions only in NEW top-level fields per chapter [03](./03-listeners-and-transport.md) §3.2).
