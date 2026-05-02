# 08 — Electron Client Migration

v0.3 ship-gate (a) requires zero `contextBridge` / `ipcMain` / `ipcRenderer` references in `packages/electron/src` (brief §11(a)). This chapter inventories every existing Electron IPC surface, maps each to a Connect call against Listener A using the proto from [04](./04-proto-and-rpc-surface.md), and pins the big-bang cutover plan, the dead-code removal procedure, and the verification harness. Migration is one PR (sequenced behind the daemon-side RPC PRs); incremental coexistence is forbidden.

### 1. Migration philosophy: big-bang, single PR

Brief §3 says **big-bang**. Why not incremental:

- Coexistence (some calls IPC, some Connect) demands two state-sync paths, two error models, and two test paths — exactly the rework the zero-rework rule forbids.
- The Electron renderer's React tree treats all data as coming from one provider; introducing a second source mid-tree requires plumbing flags everywhere.
- A clean cutover lets us delete `contextBridge`/`ipcMain` files entirely, which makes ship-gate (a) a `git rm` + `grep` rather than a partial-deletion audit.

The cutover PR is large but mechanically reviewable: every IPC call is replaced by a Connect call with a 1:1 mapping table (§3 below).

### 2. Existing IPC surface inventory

<!-- F6: closes R1 P0.1 (chapter 08) — §2 inventory replaced with the enumeration produced by `grep -rn "ipcMain\.handle\|ipcMain\.on\|contextBridge\.exposeInMainWorld" electron/` against the v0.2 codebase. Every channel is mapped to a disposition in §3 below; silent drops are forbidden. -->

The following table is the v0.3 starting state — the canonical enumeration of every `ipcMain.handle` / `ipcMain.on` / `contextBridge.exposeInMainWorld` registration in the v0.2 Electron app, grouped by source file. This list MUST be re-verified by `grep -rn "ipcMain\.handle\|ipcMain\.on\|contextBridge\.exposeInMainWorld" electron/` at the moment the migration PR is opened; any addition since this spec was written MUST be added to the §3 mapping before the PR merges. The §3 mapping assigns every channel to one of four dispositions:

- **(a) Connect RPC** — handled by an RPC against Listener A (existing or new in chapter [04](./04-proto-and-rpc-surface.md))
- **(b) renderer-only** — pure browser API in the renderer process; no IPC, no RPC
- **(c) electron-main-only** — kept as an `ipcMain.handle` channel exempt from `lint:no-ipc` via `.no-ipc-allowlist` (chapter [12](./12-testing-strategy.md) §3); these are sanctioned non-Connect main↔renderer channels for OS-chrome / OS-shell concerns that have no daemon home and no browser equivalent (frameless titlebar, native folder picker, in-app updater)
- **(d) explicitly-cut** — feature dropped in v0.3; loss acknowledged in [01](./01-overview.md) §2 non-goals (manager-handled brief amendment, dispatch plan §3) and added to the v0.2-feature-checklist as a known regression

| Source file (v0.2) | Channel / API | Direction | Purpose |
| --- | --- | --- | --- |
| `electron/ipc/dbIpc.ts` | `db:load`, `db:save` | renderer ↔ main | renderer-side persistence (theme, font, sidebar width, drafts, recent CWDs LRU, closeAction, notifyEnabled, crashReporting opt-out, pending session-rename queue, last-used model, auto-update preference, sessionTitles backfill state, etc.) |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:get` | renderer → main | read JSONL-derived session title from claude SDK |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:rename` | renderer → main | `renameSession` in claude SDK |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:listForProject` | renderer → main | list sessions in a project dir |
| `electron/ipc/sessionIpc.ts` | `sessionTitles:enqueuePending`, `sessionTitles:flushPending` | renderer → main | pending-rename queue when JSONL not yet present |
| `electron/ipc/sessionIpc.ts` | `session:setActive` | renderer → main | drives badge/notify focus muting |
| `electron/ipc/sessionIpc.ts` | `notify:userInput` | renderer → main | drives notify decider Rule 1 (60s post-input mute) |
| `electron/ipc/sessionIpc.ts` | `session:setName` | renderer → main | friendly-name mirror so toasts label correctly |
| `electron/ipc/sessionIpc.ts` | `session:state`, `session:title`, `session:cwdRedirected`, `session:activate` | main → renderer | push channels |
| `electron/ipc/utilityIpc.ts` | `import:scan` | renderer → main | scan claude CLI projects directory for importable historic sessions |
| `electron/ipc/utilityIpc.ts` | `import:recentCwds`, `app:userCwds:get`, `app:userCwds:push` | renderer → main | ccsm-owned LRU of user-picked cwds |
| `electron/ipc/utilityIpc.ts` | `app:userHome` | renderer → main | `os.homedir()` for default-cwd fallback |
| `electron/ipc/utilityIpc.ts` | `cwd:pick` | renderer → main | Electron native folder picker (`dialog.showOpenDialog`); StatusBar "Browse..." button |
| `electron/ipc/utilityIpc.ts` | `paths:exist` | renderer → main | batched existence check during hydration |
| `electron/ipc/systemIpc.ts` | `ccsm:get-system-locale` | renderer → main | OS locale for i18n seed |
| `electron/ipc/systemIpc.ts` | `ccsm:set-language` | renderer → main | push resolved UI language so OS notifications match |
| `electron/ipc/systemIpc.ts` | `app:getVersion` | renderer → main | app version string |
| `electron/ipc/systemIpc.ts` | `settings:defaultModel` | renderer → main | read `~/.claude/settings.json` `model` field as new-session default |
| `electron/ipc/windowIpc.ts` | `window:minimize`, `window:toggleMaximize`, `window:close`, `window:isMaximized` | renderer → main | custom titlebar controls (frameless window) |
| `electron/ipc/windowIpc.ts` | `window:maximizedChanged`, `window:beforeHide`, `window:afterShow` | main → renderer | titlebar state push |
| `electron/updater.ts` | `updates:status`, `updates:check`, `updates:download`, `updates:install`, `updates:getAutoCheck`, `updates:setAutoCheck` | renderer → main | electron-updater controls |
| `electron/updater.ts` | `updates:status`, `update:downloaded` | main → renderer | updater state push |
| `electron/ptyHost/ipcRegistrar.ts` | `pty:list`, `pty:spawn`, `pty:attach`, `pty:detach`, `pty:input`, `pty:resize`, `pty:kill`, `pty:get`, `pty:getBufferSnapshot` | renderer → main | PTY lifecycle |
| `electron/ptyHost/ipcRegistrar.ts` | `pty:checkClaudeAvailable` | renderer → main | detect whether `claude` CLI is on PATH and resolve the path |
| `electron/ptyHost/ipcRegistrar.ts` | `pty:data`, `pty:exit` | main → renderer | PTY output / exit push |
| `electron/preload/bridges/ccsmPty.ts` | `clipboard.readText`, `clipboard.writeText` | preload-exposed | terminal pane copy/paste via `clipboard` module |
| `electron/preload/bridges/ccsmNotify.ts` | `notify:flash` | main → renderer | AgentIcon halo pulse from main-side flash sink |
| `electron/sentry/init.ts` (no IPC channel; toggle pref) | `crashReporting` opt-out | renderer pref | gates Sentry network upload init |

### 3. Channel disposition mapping

<!-- F6: closes R1 P0.1 / P0.2 / P0.3 / P0.4 / P0.5 / P0.6 (chapter 08) — every v0.2 channel from §2 mapped to a disposition. New RPCs land in chapter [04](./04-proto-and-rpc-surface.md): `RenameSession`, `GetSessionTitle`, `ListProjectSessions`, `ListImportableSessions`, `ImportSession`, `CheckClaudeAvailable`, `GetRawCrashLog`, `NotifyService.{WatchNotifyEvents, MarkUserInput, SetActiveSid, SetFocused}`, `DraftService.{GetDraft, UpdateDraft}`. New `Settings` fields: `ui_prefs` (map), `detected_claude_default_model`, `user_home_path`, `locale`, `sentry_enabled`. New `Session.runtime_pid`. -->

The dispositions per §2:

| Channel / API | Disposition | Replacement |
| --- | --- | --- |
| `db:load`, `db:save` | (a) Connect RPC | `SettingsService.GetSettings` / `UpdateSettings` against `Settings.ui_prefs` map (chapter [04](./04-proto-and-rpc-surface.md) §6). Drafts move to `DraftService.{GetDraft, UpdateDraft}` (per-session). All `app_state` keys move to `ui_prefs`; daemon DB is the single source of truth across Electron / v0.4 web / v0.4 iOS. |
| `sessionTitles:get` | (a) Connect RPC | `SessionService.GetSessionTitle` |
| `sessionTitles:rename` | (a) Connect RPC | `SessionService.RenameSession` |
| `sessionTitles:listForProject` | (a) Connect RPC | `SessionService.ListProjectSessions` |
| `sessionTitles:enqueuePending`, `sessionTitles:flushPending` | (a) Connect RPC | Daemon owns the pending-rename queue (state in daemon); client calls `RenameSession` and daemon enqueues internally if SDK summary is not yet present. The two queue-management RPCs disappear from the client surface (daemon-internal). |
| `session:setActive` | (a) Connect RPC | `NotifyService.SetActiveSid` (chapter [04](./04-proto-and-rpc-surface.md) §6.1) |
| `notify:userInput` | (a) Connect RPC | `NotifyService.MarkUserInput` |
| `session:setName` | (a) Connect RPC | Folded into `RenameSession` (one rename surface; toast labels read from `GetSessionTitle`) |
| `session:state` (push) | (a) Connect RPC | `SessionService.WatchSessions` carries state changes via `SessionEvent.updated`; OSC-title-derived state moves into `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_TITLE` |
| `session:title` (push) | (a) Connect RPC | `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_TITLE` |
| `session:cwdRedirected` (push) | (a) Connect RPC | `SessionService.WatchSessions` `SessionEvent.updated` (cwd is a `Session` field; updates flow naturally) |
| `session:activate` (push) | (a) Connect RPC | `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_TOAST` carries the click-target session_id; renderer maps to a focus action |
| `import:scan` | (a) Connect RPC | `SessionService.ListImportableSessions` |
| `import:recentCwds`, `app:userCwds:get`, `app:userCwds:push` | (a) Connect RPC | LRU stored in `Settings.ui_prefs["recent_cwds"]` (JSON array, max 20); daemon trims server-side on update |
| `app:userHome` | (a) Connect RPC | `Settings.user_home_path` (chapter [04](./04-proto-and-rpc-surface.md) §6) |
| `cwd:pick` | (c) electron-main-only | Electron native folder picker has no daemon home and no browser equivalent. Kept as `ipcMain.handle("cwd:pick", ...)`; added to `.no-ipc-allowlist`. v0.4 web client substitutes a typed text field with autocomplete (additive net-new package; not a regression of v0.3 ship). |
| `paths:exist` | (a) Connect RPC | Daemon-side existence check piggybacked on session hydration: daemon already knows session cwd; existence flag added to `Session` in v0.4 if needed (additive). v0.3: client lazily marks a session "stale-cwd" on first attach failure (no batched-stat RPC needed at v0.3 freeze). |
| `ccsm:get-system-locale` | (a) Connect RPC | `Settings.locale` (chapter [04](./04-proto-and-rpc-surface.md) §6); daemon resolves at boot from OS APIs |
| `ccsm:set-language` | (a) Connect RPC | `SettingsService.UpdateSettings` writing `Settings.locale`; daemon picks up for OS notification language |
| `app:getVersion` | (b) renderer-only | Electron version is bundled at build time as `import.meta.env.APP_VERSION` (Vite); no IPC, no RPC. v0.4 web/iOS get the same from their own bundles. Daemon version is separate (`Hello.daemon_version` from chapter [04](./04-proto-and-rpc-surface.md) §3). |
| `settings:defaultModel` | (a) Connect RPC | `Settings.detected_claude_default_model` (chapter [04](./04-proto-and-rpc-surface.md) §6); daemon reads `~/.claude/settings.json` |
| `window:minimize`, `window:toggleMaximize`, `window:close`, `window:isMaximized` | (c) electron-main-only | Custom titlebar (frameless window) has no daemon home; native frame would be a UX regression (visible chrome change). Kept as `ipcMain.handle` channels; added to `.no-ipc-allowlist`. **Trade-off**: ship-gate (a) admits a small allowlist for OS-chrome concerns to preserve frameless UX. v0.4 web/iOS use OS-native window chrome and don't need the channels. See §3.1 below for the full allowlist contract. |
| `window:maximizedChanged`, `window:beforeHide`, `window:afterShow` | (c) electron-main-only | Same rationale; main → renderer push variants of the titlebar channels. Allowlisted. |
| `updates:status`, `updates:check`, `updates:download`, `updates:install`, `updates:getAutoCheck`, `updates:setAutoCheck`, `update:downloaded` | (c) electron-main-only | `electron-updater` is Electron-process-bound (autoUpdater APIs require Electron main); no daemon equivalent. Kept as `ipcMain.handle` channels; added to `.no-ipc-allowlist`. v0.4 web client gets updates via service-worker / browser refresh; v0.4 iOS via App Store. Updater UI in renderer Settings stays. |
| `pty:list`, `pty:spawn`, `pty:get` | (a) Connect RPC | `SessionService.ListSessions` / `CreateSession` / `GetSession` (PTY lifecycle is session lifecycle in v0.3) |
| `pty:attach`, `pty:detach`, `pty:data` | (a) Connect RPC | `PtyService.Attach` (server-stream); detach by closing the stream |
| `pty:input` | (a) Connect RPC | `PtyService.SendInput` |
| `pty:resize` | (a) Connect RPC | `PtyService.Resize` |
| `pty:kill` | (a) Connect RPC | `SessionService.DestroySession` |
| `pty:getBufferSnapshot` | (a) Connect RPC | First frame of `PtyService.Attach` (`PtyFrame.snapshot`); explicit snapshot RPC not needed |
| `pty:exit` (push) | (a) Connect RPC | `SessionService.WatchSessions` `SessionEvent.updated` carries `state == EXITED` + `exit_code` + `runtime_pid` cleared |
| `pty:checkClaudeAvailable` | (a) Connect RPC | `PtyService.CheckClaudeAvailable` (chapter [04](./04-proto-and-rpc-surface.md) §4) |
| `clipboard.readText`, `clipboard.writeText` | (b) renderer-only | Standard browser `navigator.clipboard.{readText,writeText}` from the renderer. Requires a one-time user-gesture for read on first use; v0.2 had no such gesture (preload-exposed `clipboard` module bypassed it), so the renderer's terminal paste handler MUST request permission on first paste. v0.4 web/iOS use the same browser API. |
| `notify:flash` (push) | (a) Connect RPC | `NotifyService.WatchNotifyEvents` `NOTIFY_KIND_FLASH` |
| `crashReporting` opt-out | (a) Connect RPC | `Settings.sentry_enabled` (chapter [04](./04-proto-and-rpc-surface.md) §6); chapter [09](./09-crash-collector.md) §5 details the read path |

The legacy `app:open-external` channel from older v0.3 drafts is **explicitly cut**: opening external URLs is now `window.open(url, '_blank')` in the renderer for `https?://` only (rejected for `file://`, `javascript:`, etc. — see §3.2 below); opening daemon-side files (e.g., the raw crash log) is replaced with `CrashService.GetRawCrashLog` + a "Download raw log" UI in chapter [09](./09-crash-collector.md) §5. Symmetric across Electron / v0.4 web / v0.4 iOS.

> If any new IPC is found during migration that does NOT fit into one of the existing services, the migration PR MUST add the corresponding RPC to proto + daemon BEFORE merging the Electron change. New RPCs follow the additivity contract from [04](./04-proto-and-rpc-surface.md) §8 — this is a v0.3 first-ship addition, not a v0.4 add.

#### 3.1 `.no-ipc-allowlist` contract (electron-main-only channels)

<!-- F6: closes R1 P0.3 / P0.6 / P1.5 (chapter 08) + R4 P0 ch 08 lint allowlist mechanism. The window:* + cwd:pick + updates:* channels are the explicit, finite, frozen allowlist for v0.3 ship. Kept as `ipcMain.handle` channels; ship-gate (a) `lint:no-ipc` reads `.no-ipc-allowlist` to skip these. -->

The `.no-ipc-allowlist` file at `packages/electron/.no-ipc-allowlist` enumerates the **finite, frozen** set of `ipcMain.handle` channel names that are exempt from the `lint:no-ipc` rule (chapter [12](./12-testing-strategy.md) §3 implements; §5h.1 below specifies). v0.3 contents are exactly:

```
# OS-chrome: custom titlebar (frameless window). No daemon home; native
# frame would be a visible UX regression. v0.4 web/iOS use OS-native chrome.
window:minimize
window:toggleMaximize
window:close
window:isMaximized
window:maximizedChanged
window:beforeHide
window:afterShow

# OS-shell: native folder picker. No browser equivalent; v0.4 web client
# substitutes typed text field (additive net-new).
cwd:pick

# In-app updater: electron-updater is Electron-process-bound. v0.4 web
# updates via service-worker; v0.4 iOS via App Store.
updates:status
updates:check
updates:download
updates:install
updates:getAutoCheck
updates:setAutoCheck
update:downloaded
```

**Rules**:

1. Every entry in this file is a `string` matching an `ipcMain.handle` channel name. Comments start with `#`. Blank lines ignored.
2. The file is FROZEN at v0.3 ship. Adding a new entry post-ship is a brief amendment + chapter 15 §3 forbidden-pattern review (the only legitimate path is a NEW OS-chrome / OS-shell concern that has no daemon home AND no browser equivalent).
3. The corresponding `ipcMain.handle` registrations live in named files under `packages/electron/src/main/ipc-allowlisted/` (one file per channel cluster: `window-controls.ts`, `folder-picker.ts`, `updater.ts`). The `lint:no-ipc` rule scopes the allowlist file-by-file: only files under `ipc-allowlisted/` may import `ipcMain`, and only for the channel names in `.no-ipc-allowlist`.
4. `contextBridge.exposeInMainWorld` is NOT allowlisted under any circumstance — the descriptor injection mechanism uses `protocol.handle` (§4.1) and OS-chrome / OS-shell channels expose their renderer-side wrappers via a separate `packages/electron/src/preload/allowlisted-bridges.ts` that uses `electron`'s `ipcRenderer` directly (in a single file also enumerated in `.no-ipc-allowlist` as a special `__preload__` token).

#### 3.2 Renderer-only `window.open` URL safety

<!-- F6: closes R4 P1 ch 08 `app:open-external` URL safety test. -->

The renderer's "open external link" affordance accepts `https?://` only; every other scheme (`file://`, `javascript:`, `data:`, `chrome://`, `app://`, etc.) is rejected before `window.open` is called. The check lives in `packages/electron/src/renderer/lib/safe-open-url.ts` (a tiny module that wraps `URL` parsing + scheme allowlist) and is exercised by `packages/electron/test/ui/safe-open-url.spec.ts` covering: `https://example.com` (allowed), `http://example.com` (allowed), `file:///etc/passwd` (rejected), `javascript:alert(1)` (rejected), malformed URL (rejected), empty string (rejected). v0.4 web/iOS reuse the same module (it has no Electron-specific imports).

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
   e2. Re-create the allowlisted `ipcMain.handle` registrations under `packages/electron/src/main/ipc-allowlisted/{window-controls.ts, folder-picker.ts, updater.ts}` (per §3.1) and the matching renderer-side wrappers in `packages/electron/src/preload/allowlisted-bridges.ts`. Both surfaces use `electron`'s `ipcMain` / `ipcRenderer` directly — only these files may, and only for the channel names in `.no-ipc-allowlist`.
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
4. Any usage of `webContents.send`, `webContents.executeJavaScript`, `MessageChannelMain`, `MessagePortMain`, or `process.parentPort` outside `packages/electron/src/main/transport-bridge.ts` AND outside `packages/electron/src/main/ipc-allowlisted/` (the only sanctioned non-Connect main↔renderer surfaces). The bridge is exempt because it speaks Connect framing; the allowlisted IPC files use `webContents.send` only for the push variants of allowlisted channels (e.g., `window:maximizedChanged`).

**Allowlist**: the FROZEN `.no-ipc-allowlist` file (§3.1) enumerates the finite set of `ipcMain.handle` channel names exempt from rule 3 above (window controls, native folder picker, in-app updater). The corresponding files live under `packages/electron/src/main/ipc-allowlisted/`; the lint rule scopes the allowlist file-by-file (only those files may import `ipcMain`, and only for the channel names in `.no-ipc-allowlist`). The descriptor injection mechanism uses `protocol.handle` (§4.1), which is NOT on the forbidden-pattern list — no allowlist entry is needed for it. `contextBridge.exposeInMainWorld` is NEVER allowlisted.

**Implementation reference**: chapter [12](./12-testing-strategy.md) §3 ships the actual ESLint config + the `tools/lint-no-ipc.sh` driver script + the CI wiring; chapter 08 §5h.1 is the spec.

### 6. Renderer error-handling contract

- Every RPC may fail with `UNAVAILABLE` (daemon restarting); UI shows a non-blocking banner "Reconnecting..." and the underlying React Query retries with backoff.
- `PERMISSION_DENIED` is treated as a programming error (the only principal in v0.3 is `local-user`; ownership mismatch should not happen on a single-user machine). UI shows an error toast and logs to console; UX is "should be impossible".
- `FAILED_PRECONDITION` from `Hello` (version mismatch) shows a blocking modal "Daemon version X is incompatible with this Electron build (min Y). Please update.".
- Stream errors (`Attach`, `WatchSessions`, `WatchCrashLog`, `WatchNotifyEvents`) trigger automatic reattach with exponential backoff capped at 30s. Reattach uses the recorded last-applied seq for `Attach`. The backoff schedule is locked: `min(30s, 500ms * 2^attempt + jitter)` where jitter is uniform [0, 250ms]. Tested in `packages/electron/test/rpc/reconnect-backoff.spec.ts` with a fault-injecting transport.

#### 6.1 Daemon cold-start UX (daemon unreachable at boot)

<!-- F6: closes R1 P1.3 (chapter 08) — daemon-crash → blank-screen UX. -->

If the renderer's first `Hello` does not succeed within **8 seconds** (cold-start budget; covers daemon-still-starting on a slow VM), the renderer renders a blocking modal:

> **ccsm daemon is not running.**
>
> The ccsm background service did not respond after 8 seconds. The renderer will keep retrying in the background.
>
> [Try again now] [Open service troubleshooting]

- "Try again now" forces an immediate `Hello` retry (resets the backoff timer).
- "Open service troubleshooting" opens a renderer-side help page (no IPC, no RPC) with per-OS instructions: Windows (`Get-Service ccsm`), macOS (`launchctl print system/com.ccsm.daemon`), Linux (`systemctl status ccsm`).
- The modal is dismissible only by a successful `Hello`. The renderer continues retrying with the standard backoff (§6 above) in the background; on success the modal disappears and normal UI hydrates.

This converts the "blank screen with reconnecting banner forever" failure mode into an actionable user-facing diagnosis. The modal is a renderer-only React component (no IPC, no RPC); it depends only on the connection state surfaced by the Connect transport's first-Hello failure path.

#### 6.2 React Query renderer state layer

<!-- F6: closes R0 08-P1.2 — abstraction shape locked; v0.4 web/iOS share or duplicate. -->

The renderer wraps every proto-generated client method in a thin React Query hook layer at `packages/electron/src/renderer/rpc/queries.ts`. The abstraction shape is **forever-stable**:

- Unary RPCs: one hook per method, named `use<MethodName>` (e.g., `useListSessions(params)`), backed by `useQuery` / `useSuspenseQuery` (read) or `useMutation` (write).
- Server-stream RPCs: one hook per method, named `useWatch<Name>` (e.g., `useWatchSessions()`), backed by a custom hook that subscribes on mount, pushes events into a React Query cache key, and unsubscribes on unmount.
- Hooks return the same `{data, error, isPending, ...}` shape across all methods.

v0.4 web client may either (a) share the file (move to `packages/shared-renderer/`) additively, or (b) duplicate. Either is fine because the abstraction shape is locked. v0.4 iOS uses native SwiftUI state; the abstraction shape concept (one hook per RPC) maps to a parallel Swift module (`SessionService.listSessions() async throws -> [Session]`). Chapter [11](./11-monorepo-layout.md) §2 documents the package boundary.

### 7. Verification harness (ship-gate (a) and (b))

- Static (gate (a)): the `lint:no-ipc` script in CI; blocks merge.
- Runtime (gate (b)): an E2E test at `packages/electron/test/e2e/sigkill-reattach.spec.ts` that:
  1. Starts daemon (in CI: in-process; in nightly: service-installed VM).
  2. Launches Electron in test mode, creates 3 sessions, waits for `RUNNING`.
  3. Records each session's last applied PTY seq AND each session's `runtime_pid` (from `Session.runtime_pid`, chapter [04](./04-proto-and-rpc-surface.md) §3 — added in v0.3 freeze precisely for this gate).
  4. SIGKILLs the Electron main PID.
  5. Verifies daemon is still up via Supervisor `/healthz`.
  6. Verifies each session's `claude` CLI subprocess is still alive by probing the recorded `runtime_pid`: on POSIX `process.kill(pid, 0)` (signal 0 tests existence without delivering a signal); on Windows `Get-Process -Id <pid>` via a `child_process.spawnSync('powershell', ...)`. Exit code 0 → alive.
  7. Relaunches Electron; waits for connect; verifies the 3 sessions appear; reattaches each; asserts `Attach` returns deltas continuing from the recorded seq (no gap, no duplicate).
- Bridge round-trip (gate (b) supplement): `packages/electron/test/rpc/bridge-roundtrip.spec.ts` exercises bridge → daemon for unary, server-stream, error, and slow-consumer cases. Closes R4 P1 transport-bridge testability.
- Descriptor immutability: `packages/electron/test/preload/descriptor-immutable.spec.ts` asserts the descriptor served via `protocol.handle` cannot be tampered with from the renderer (renderer-side mutation does not propagate; the Connect transport is constructed exactly once at boot from the original descriptor). Closes R4 P1 descriptor-tamper testability.
- Stream backoff: `packages/electron/test/rpc/reconnect-backoff.spec.ts` (per §6 above).
- Open-external URL safety: `packages/electron/test/ui/safe-open-url.spec.ts` (per §3.2).
- Big-bang rollback story: the migration PR ships a feature flag `CCSM_TRANSPORT=ipc|connect` in the Electron main process selecting between the legacy IPC stack and the Connect stack for ONE release after merge. Default flips to `connect` immediately; the `ipc` path is retained only as a fast-revert escape hatch (per chapter [13](./13-release-slicing.md) §2 phase 8 split). Removed in v0.3.1 cleanup.

### 8. v0.4 delta

- **Add** new RPCs as needed; the renderer's clients factory automatically picks them up from regenerated proto stubs. Existing call sites: unchanged.
- **Add** new UI for v0.4 features (tunnel toggle, principal switcher) by composing additional React Query hooks against new RPCs.
- **Web/iOS clients DO NOT use the transport bridge** (§4.2): they speak `connect-web` / `connect-swift` directly to Listener B over cloudflared. The bridge is forever Electron-internal; chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern locks "v0.4 MUST NOT modify `packages/electron/src/main/transport-bridge.ts` for web/iOS reasons."
- **Unchanged**: every existing call site, the `protocol.handle` descriptor injection mechanism (§4.1), the `lint:no-ipc` rule (still gates merge in v0.4 too — chapter 08 §5h.1 is forever-stable), the error contract, the cutover-style migration philosophy (v0.4 web/iOS clients are net-new packages, not migrations), the descriptor schema (additions only in NEW top-level fields per chapter [03](./03-listeners-and-transport.md) §3.2).
