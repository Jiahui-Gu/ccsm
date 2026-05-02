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

```
electron main process (minimal):
  - BrowserWindow lifecycle (create/show/close)
  - reads listener-a.json, exposes the descriptor to renderer via a SINGLE
    initial preload-time global: window.__CCSM_LISTENER__ = { transport, address, ... }
  - NO ipcMain.handle calls
  - NO business logic
  - tray menu (quit / open settings) — UI, no IPC

electron preload (minimal):
  - reads window.__CCSM_LISTENER__ (already injected by main via webPreferences.additionalArguments)
  - NO contextBridge.exposeInMainWorld for callable APIs
  - the descriptor is the ONLY thing exposed; everything else is renderer-side Connect

electron renderer:
  - constructs a Connect transport from window.__CCSM_LISTENER__
  - wraps the proto-generated SessionService/PtyService/... clients in React Query / TanStack Query hooks
  - all UI state comes from RPC results
```

**Why expose the descriptor via `additionalArguments` not `contextBridge`**: `contextBridge` is the regulated channel for callable APIs; passing a static read-only object via `additionalArguments` keeps the grep gate clean (`contextBridge` literally does not appear in the source) while still respecting Electron's context isolation. The descriptor object is JSON-serializable and contains no functions.

> **MUST-SPIKE [renderer-h2-uds]**: hypothesis: an Electron renderer (Chromium) can talk Connect-RPC over the chosen Listener A transport without an electron-main proxy. UDS / named pipe via fetch is unsupported in Chromium; loopback TCP is fine. · validation: smoke each transport from a renderer page. · fallback: a tiny **transport bridge** in the main process — a plain `http2.Server` on `127.0.0.1:<ephemeral>` that proxies to the UDS / named pipe; renderer connects to the loopback. The bridge is NOT an IPC re-introduction (it speaks Connect, same proto, no `ipcMain.handle`); ship-gate (a) grep still passes.

### 5. Cutover sequence (single PR)

1. (Pre-PR) Daemon-side PRs land: every RPC in [04](./04-proto-and-rpc-surface.md) is implemented and tested behind a feature-flag-gated daemon binary. Connection descriptor is written. Listener A binds. Integration tests against the daemon pass.
2. (PR) The Electron migration PR:
   a. Add `packages/electron/src/rpc/clients.ts` constructing typed clients from the descriptor.
   b. Add `packages/electron/src/rpc/queries.ts` wrapping each in React Query hooks.
   c. Replace every existing `ipcRenderer.invoke(...)` and `ipcRenderer.on(...)` site with the corresponding hook (mechanical 1:1).
   d. Delete `packages/electron/src/main/ipc/` directory.
   e. Delete `packages/electron/src/preload/contextBridge.ts`.
   f. Replace preload with a 5-line file that injects the descriptor.
   g. Update `packages/electron/src/main/index.ts` to remove all `ipcMain.handle` registrations and instead spawn a tray menu only.
   h. Add the `npm run lint:no-ipc` script: `grep -r "contextBridge\|ipcMain\|ipcRenderer" packages/electron/src && exit 1 || exit 0`.
   i. Wire the script into CI (see [12](./12-testing-strategy.md) §3).
3. (Post-merge) E2E test (ship-gate (a)/(b)/(c)) runs in CI nightly and on every release tag.

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
- **Unchanged**: every existing call site, the descriptor injection mechanism, the no-IPC lint rule (still gates merge in v0.4 too), the error contract, the cutover-style migration philosophy (v0.4 web/iOS clients are net-new packages, not migrations).
