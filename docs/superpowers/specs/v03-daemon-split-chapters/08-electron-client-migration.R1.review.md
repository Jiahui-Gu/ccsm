# R1 (feature-preservation) review of 08-electron-client-migration.md

The spec's IPC inventory in §2 and IPC→Connect mapping in §3 cover **only ~15 channels**, which is a tiny fraction of the actual IPC surface in `electron/`. Today's app has **~40 distinct IPC channels** spread across 5 preload bridges (`ccsm`, `ccsmPty`, `ccsmNotify`, `ccsmSession`, `ccsmSessionTitles`) and 7 main-side registrar files (`dbIpc`, `sessionIpc`, `utilityIpc`, `systemIpc`, `windowIpc`, `updater`, `ptyHost/ipcRegistrar`, plus `notify/sinks/*` and `sessionWatcher/*` push channels). The spec's mapping table omits the great majority of them. Per the chapter's own rule ("every handler should have a 1:1 mapping; missing mapping = P0 (feature drops)") and per ship-gate (a) (zero IPC residue), every omitted channel is a feature that will either silently disappear from v0.3 or block the no-IPC grep.

## P0 findings (block ship; user-visible feature drops or breaks)

### P0.1 IPC inventory in §2 is missing ~25+ channels and 4 of 5 preload bridges entirely

**Location**: `08-electron-client-migration.md` §2 ("Existing IPC surface inventory") and §3 ("IPC → Connect mapping")
**Current behavior** (verified by `grep -rn "ipcMain\.handle\|ipcMain\.on\|contextBridge\.exposeInMainWorld" electron/`):

The §2 table lists 15 channels and uses fictional names like `session:list`, `pty:attach`, `crash:list`, `app:open-external`, `crash:event`, `settings:get`. None of these channel names actually exist in the codebase. The real channels — and the user features behind them — are:

A. `electron/ipc/dbIpc.ts`:
- `db:load`, `db:save` — renderer-side persistence of theme, fontSize, fontSizePx, sidebar width, drafts, recent CWDs LRU, closeAction, notifyEnabled, crashReporting opt-out, pending session-rename queue, last-used model, auto-update preference, sessionTitles backfill state, and many other keys (free-form key/value over `app_state` SQLite table).

B. `electron/ipc/sessionIpc.ts`:
- `sessionTitles:get` — read JSONL-derived session title from claude SDK
- `sessionTitles:rename` — `renameSession` in claude SDK
- `sessionTitles:listForProject` — list sessions in a project dir
- `sessionTitles:enqueuePending`, `sessionTitles:flushPending` — pending-rename queue when JSONL not yet present
- `session:setActive` (renderer→main, fire-and-forget) — drives badge/notify focus muting
- `notify:userInput` — drives notify decider Rule 1 (60s post-input mute)
- `session:setName` — friendly-name mirror so toasts label correctly
- Push channels: `session:state`, `session:title`, `session:cwdRedirected`, `session:activate`

C. `electron/ipc/utilityIpc.ts`:
- `import:scan` — scan claude CLI projects directory for importable historic sessions (file:`electron/import-scanner.ts`)
- `import:recentCwds`, `app:userCwds:get`, `app:userCwds:push` — ccsm-owned LRU of user-picked cwds (PR #628)
- `app:userHome` — `os.homedir()` for default-cwd fallback
- `cwd:pick` — Electron native folder picker (`dialog.showOpenDialog`); the StatusBar "Browse..." button
- `paths:exist` — batched existence check used during hydration to flag stale-cwd sessions

D. `electron/ipc/systemIpc.ts`:
- `ccsm:get-system-locale` — OS locale for i18n seed
- `ccsm:set-language` — push resolved UI language so OS notifications match
- `app:getVersion` — app version string
- `settings:defaultModel` — read user's `~/.claude/settings.json` `model` field as new-session default

E. `electron/ipc/windowIpc.ts`:
- `window:minimize`, `window:toggleMaximize`, `window:close`, `window:isMaximized` — custom titlebar controls (frameless window)
- Push: `window:maximizedChanged`, `window:beforeHide`, `window:afterShow`

F. `electron/updater.ts`:
- `updates:status`, `updates:check`, `updates:download`, `updates:install`, `updates:getAutoCheck`, `updates:setAutoCheck`
- Push: `updates:status`, `update:downloaded`

G. `electron/ptyHost/ipcRegistrar.ts`:
- `pty:list`, `pty:spawn`, `pty:attach`, `pty:detach`, `pty:input`, `pty:resize`, `pty:kill`, `pty:get`, `pty:getBufferSnapshot`, `pty:checkClaudeAvailable` (latter detects whether `claude` CLI is on PATH and returns the resolved path)
- Push: `pty:data`, `pty:exit`

H. `electron/preload/bridges/ccsmPty.ts`:
- `clipboard.readText`, `clipboard.writeText` — exposed via `clipboard` module directly in preload (used by the terminal pane for copy/paste). NOT an IPC handler but lives behind `contextBridge` and disappears when contextBridge is removed.

I. `electron/preload/bridges/ccsmNotify.ts`:
- Push: `notify:flash` — AgentIcon halo pulse from main-side flash sink (PR #689)

**Spec behavior**: §3 mapping table mentions only `session:list/get/create/destroy/event`, `pty:attach/data/input/resize`, `crash:list/event`, `settings:get/set`, `app:version`, `app:open-external`. Everything in A-I above is unmapped.

**Gap**: every unmapped channel is a user-visible feature. After cutover the renderer's `window.ccsm.*`, `window.ccsmPty.clipboard.*`, `window.ccsmSession.*`, `window.ccsmSessionTitles.*`, `window.ccsmNotify.*` references all become `undefined` and the corresponding UI breaks: theme/font don't persist across launches, custom titlebar buttons no-op, OS folder picker for new-session cwd no-op (regression of PR #628), session-rename via claude SDK gone, importable-session list gone, recent-cwd popover empty, in-app updater UI gone, OSC-title flash halo gone, focus-driven badge clearing gone, notification toast labels show UUIDs, language switch doesn't reach OS notifications, copy/paste in terminal gone, default model picker gone.

**Suggested fix**: §2 inventory must be replaced by the *actual* enumeration produced by `grep -rn "ipcMain\.handle\|ipcMain\.on\|contextBridge\.exposeInMainWorld" electron/` against the current code at spec-time. Each channel must appear in §3 with one of three explicit dispositions: (a) mapped to a Connect RPC (and that RPC must then exist in chapter 04 proto); (b) preserved as a renderer-only behavior (and the chapter must say which renderer module owns it); (c) explicitly cut as a v0.3 feature loss (and that loss must be acknowledged in `01-overview` §2 non-goals plus a migration note for users who relied on it). Silence is unacceptable.

### P0.2 Settings RPC carries 3 fields; ~10+ persisted user prefs are dropped

**Location**: `04-proto-and-rpc-surface.md` §6 (`Settings` message); `08-electron-client-migration.md` §3 (`settings:get/set` row)
**Current behavior**: today's app persists, via `db:load/save` on the `app_state` table (single key/value store, all owned by Electron):

- `theme` (light / dark / system) — `src/stores/slices/appearanceSlice.ts`
- `fontSize` (legacy enum) and `fontSizePx` (12-16 px) — same file
- sidebar width — same file
- composer drafts (per-session) — `src/stores/drafts.ts`
- `closeAction` (ask/tray/quit) — `electron/prefs/closeAction.ts`
- `notifyEnabled` (master toggle) — `electron/prefs/notifyEnabled.ts`
- `crashReporting` opt-out — `electron/prefs/crashReporting.ts`
- user-cwds LRU (max 20) — `electron/prefs/userCwds.ts`
- updater auto-check toggle — `electron/updater.ts`
- per-session pending-rename queue — `electron/sessionTitles/index.ts`
- UI language — `src/i18n` + main mirror via `ccsm:set-language`

**Spec behavior**: chapter 04 §6 freezes `Settings` as `{ claude_binary_path, default_geometry, crash_retention }` only. Chapter 07 §2 says "Electron-side state ... contains: window geometry, last-applied-seq cache for fast reconnect, theme. NOT authoritative; deletable any time." That is the only mention.

**Gap**:
1. The forever-stable `Settings` message has no field for any of the existing prefs above. Adding them in v0.4 is allowed as additive new fields, but in v0.3 they have no daemon-side home — so where do they live? Spec says "Electron-side, ephemeral, deletable any time." That's a regression: today these prefs survive cache wipes because they're in `%APPDATA%`/`Library Support`/`~/.config` not "ephemeral cache" semantics. More importantly, web/iOS clients in v0.4 will not see the user's theme/font/closeAction at all unless those prefs are daemon-resident.
2. v0.3 ships with a daemon that has a `Settings` schema purposely too small to ever hold these prefs without v0.4 schema reshape — but the chapter promises forever-stable. So either (a) every existing pref is stranded in Electron-only storage forever, or (b) v0.4 must bolt them onto `Settings`, which is allowed (additive) but ugly because it should have been designed in v0.3.
3. Spec §3 of chapter 08 says `settings:get` → `SettingsService.GetSettings`. But `db:load/save` (the actual persistence path for these prefs) is **not** `settings:get/set` — it's a much broader key/value store. The chapter's mapping omits `db:load/save` entirely. After cutover, calling `window.ccsm.loadState('theme')` returns undefined and the renderer's `persistMiddleware` (`src/stores/persist.ts`) silently fails to hydrate.

**Suggested fix**: §6 of chapter 04 must add either (i) a generic key/value RPC (`AppStateService.Get(key)/Set(key,value)/List(prefix)`) backed by the existing `app_state` table moved to the daemon, OR (ii) explicit fields for each existing pref with v0.3-locked semantics. Chapter 08 must map every `db:load`/`db:save` call site (run `grep -rn "loadState\|saveState\|window.ccsm.loadState\|window.ccsm.saveState" src/`) to the chosen RPC. Chapter 07 §2 must clarify that any pref currently in `app_state` either moves to the daemon DB or is explicitly downgraded to "ephemeral local cache" with a user-facing release note about loss-on-wipe.

### P0.3 Custom titlebar window controls have no Connect equivalent — clicking minimize/maximize/close does nothing

**Location**: `08-electron-client-migration.md` §3 and §4
**Current behavior**: `electron/ipc/windowIpc.ts` exposes `window:minimize / toggleMaximize / close / isMaximized` plus push events `window:maximizedChanged / beforeHide / afterShow`. The renderer's titlebar component (frameless window — `electron/window/createWindow.ts` uses no native frame) calls these on every click.

**Spec behavior**: §4 says main process keeps "BrowserWindow lifecycle (create/show/close)" but chapter 08 has no mapping for window controls. These are pure-UI concerns of the host OS chrome — they don't belong in a daemon RPC and they don't belong on a web/iOS client either.

**Gap**: After cutover the titlebar buttons are broken. The user cannot minimize, maximize, or close the window via the in-app chrome on Windows/Linux (where the frame is hidden by design).

**Suggested fix**: chapter 08 §3 must add a third disposition (alongside "Connect RPC" and "renderer-only") explicitly named **"electron-main-only via additionalArguments callback / custom remote-style channel that is NOT `ipcMain.handle`"**, and either (a) note that `window:*` are kept as ipc handlers but excluded from the lint regex (compromises ship-gate (a)), or (b) move the entire titlebar to native-frame mode in v0.3 (UX regression — visible chrome change), or (c) document a sanctioned non-IPC main↔renderer channel (e.g., a tiny localhost http server in main that the renderer hits, like the `transport bridge` already proposed for h2). Currently the spec is silent and the lint passes by deleting these handlers, breaking the feature.

### P0.4 Notify pipeline (toast / badge / flash / OSC-title decider) is dropped

**Location**: spec is silent; should be in `08` §3 and `04` proto somewhere
**Current behavior**: a non-trivial main-process subsystem (`electron/notify/*`, `electron/sessionWatcher/*`, `electron/badgeController.ts`, `electron/notify/notifyDecider.ts`) implements:
- 7-rule notify decider (toast + flash matrix based on focus, active sid, run duration, mute, dedupe — see `electron/notify/notifyDecider.ts` header)
- Toast sink → OS native notification (`electron/notify/sinks/toastSink.ts`)
- Badge sink → app icon dock/taskbar badge with unread count
- Flash sink → AgentIcon halo pulse pushed to renderer via `notify:flash`
- JSONL tail-watcher (`sessionWatcher/fileSource.ts`) infers per-session state (`idle | running | requires_action`) from claude CLI's JSONL output, pushed via `session:state`
- OSC-title parser as the notify trigger
- Session-title push when SDK summary changes
- "Click toast → focus that sid" via `session:activate` push channel

**Spec behavior**: zero mention of any of this. Chapter 08 §3 has no `session:state` / `session:title` / `notify:flash` / `session:activate` rows. The notify pipeline today lives in main process and depends on PTY data + JSONL tail. After daemon split it MUST move to the daemon (the only place those signals exist) and reach the client via streams.

**Gap**: After cutover:
- No more OS notifications when a background session needs the user's attention.
- No more app-icon badge with unread count.
- No more AgentIcon halo pulse.
- No more SDK-derived session titles auto-appearing in the sidebar.
- No more click-toast-to-focus.
- The 7-rule decider's accumulated UX tuning (PR #689 and follow-ups) is lost.

**Suggested fix**: chapter 04 must add `NotifyService` (or similar) with at least `WatchNotifyEvents() returns (stream NotifyEvent)` carrying `{sid, kind: TOAST|FLASH|BADGE_UPDATE, payload}`, and the decider state must move to the daemon (it already has all the inputs; only `focused` and `activeSid` come from the client). Chapter 08 must map `session:state`, `session:title`, `session:cwdRedirected`, `session:activate`, `notify:flash`, `notify:userInput`, `session:setActive`, `session:setName` to either Connect calls or stream events. Today's per-OS toast UI must continue to work — the daemon (running as a system service) firing a notification on behalf of a logged-out user is a different model than today and needs explicit treatment.

### P0.5 Session rename via claude SDK and importable-session scan have no RPC

**Location**: `04-proto-and-rpc-surface.md` §3 (`SessionService`); `08` §3
**Current behavior**:
- `electron/sessionTitles/index.ts` wraps `@anthropic-ai/claude-agent-sdk`'s `getSessionInfo` / `renameSession` / `listSessions`. Renderer calls via `window.ccsmSessionTitles.{get,rename,listForProject,enqueuePending,flushPending}`. The Sidebar rename UI, the Sidebar title display, and the launch-time backfill all depend on this.
- `electron/import-scanner.ts` scans `~/.claude/projects/*` and returns importable historic sessions for the "Import session" UI.

**Spec behavior**: `SessionService` has only Hello / List / Get / Create / Destroy / Watch. No rename. No SDK-list. No import-scan.

**Gap**: After cutover the user can no longer rename a session, the sidebar shows blank titles instead of SDK summaries, and the "Import existing claude session" button is dead.

**Suggested fix**: add `SessionService.RenameSession(session_id, new_title)`, `SessionService.GetSdkInfo(session_id)`, `SessionService.ListImportable() returns (repeated ImportableSession)` — or a sibling `ClaudeSdkService` if the author prefers separation. These are forever-stable surfaces from day one.

### P0.6 OS folder picker (`cwd:pick`) has no replacement

**Location**: `08` §3
**Current behavior**: `cwd:pick` opens `dialog.showOpenDialog` (Electron native folder picker). PR #628 fixed the StatusBar "Browse..." button; before that, picked cwds silently fell back to home (real bug, real regression risk).

**Spec behavior**: not in the mapping. `app:open-external` is "browser-native window.open" but a folder *picker* has no browser equivalent.

**Gap**: User cannot pick a folder for a new session except by typing the path. Hard regression of PR #628.

**Suggested fix**: chapter 08 §3 must add `cwd:pick` as `electron-main-only` (browser file picker isn't a folder picker; native dialog is the only option). For v0.4 web client this becomes a typed text field with autocomplete or a server-side fs-walk picker — but in v0.3 it's an Electron-only feature and must stay wired.

## P1 findings (must-fix; UX regression or silent migration)

### P1.1 No migration plan for existing user data on disk

**Location**: `07-data-and-state.md` §4 ("Migration story") covers daemon-side migrations only
**Current behavior**: today's user has data in:
- `%APPDATA%/ccsm/` (mac/linux equivalents) — Electron's `app.getPath('userData')` containing `ccsm.db` (the `app_state` table with theme, drafts, prefs, recent cwds), session metadata, history.
- `~/.claude/projects/*` — claude CLI's JSONL tail watched by sessionWatcher.

**Spec behavior**: §2 specifies brand new daemon paths (`%PROGRAMDATA%\ccsm\`, `/Library/Application Support/ccsm/`, `/var/lib/ccsm/`). Spec is silent on whether any data from the old user-scope paths gets migrated. §4 covers schema migrations *within* the new DB only.

**Gap**: An existing v0.2 user upgrading to v0.3 finds: theme back to default, font back to default, drafts gone, recent cwds gone, custom close-action preference gone, notify-enabled toggle reset, crash-reporting opt-out reset, session list empty (sessions table is brand new). This is a silent data loss event with no user notice.

**Suggested fix**: chapter 07 must add a §4.5 "v0.2 → v0.3 user-data migration" subsection stating either (a) the installer copies / converts the old `app_state` rows into the new daemon DB, or (b) the spec explicitly accepts the loss and the installer surfaces a "first-launch welcome / your previous settings could not be carried over" dialog. Silence = silent data loss = P1.

### P1.2 Daemon as system service changes the per-user data model — no per-user isolation called out

**Location**: `02-process-topology.md`, `07-data-and-state.md` §2
**Current behavior**: today's app stores data per-user under `app.getPath('userData')`. Two OS users on the same machine each have their own data, isolated by OS file permissions.

**Spec behavior**: daemon runs as system service with state under `%PROGRAMDATA%` / `/Library/Application Support` / `/var/lib/ccsm`. The principal model (`local-user:<uid>`) makes session data per-uid, but settings, crash log, raw crash log file are global across all OS users on the box (chapter 05 §5 explicitly says settings are global in v0.3).

**Gap**: On a multi-user Mac/Linux/Windows machine, two users now share theme, font, prefs, and see each other's crash log entries. That's a privacy/UX regression vs. today (where each user has independent ccsm state). Even on a single-user dev laptop, if the user `sudo`s and runs ccsm, the principal flips and they see different sessions.

**Suggested fix**: either acknowledge the multi-user regression in `01-overview.md` §2 non-goals, or add a per-principal settings table from day one (chapter 05 §5 already flags this for v0.4 — pull it into v0.3 if multi-user is a supported scenario today).

### P1.3 Daemon crash → blank screen UX undefined

**Location**: `08-electron-client-migration.md` §6 ("Renderer error-handling contract")
**Current behavior**: today, an in-process crash kills the whole app and the OS service manager / Electron auto-restart brings it back. The user sees an OS-level "app quit unexpectedly" dialog at most.

**Spec behavior**: §6 says `UNAVAILABLE` shows "non-blocking banner 'Reconnecting...' and the underlying React Query retries with backoff." But the renderer's initial UI requires `ListSessions` + `WatchSessions` + `GetSettings` to populate anything. If the daemon is dead at boot, what does the user see?

**Gap**: Possible UX of "blank screen with reconnecting banner" indefinitely if the daemon failed to start. No fallback to "show a last-known cached session list" because the spec says renderer is stateless.

**Suggested fix**: §6 must specify the cold-start UX when daemon is unreachable: timeout → modal "ccsm daemon is not running. Try restarting the service. [details]" with actionable troubleshooting + a button to spawn the daemon manually (today's app would have just crashed, but today's user has no service to restart — this is a new failure mode the refactor introduces).

### P1.4 Drafts (per-session composer text) loss-on-restart is a silent regression

**Location**: chapter 07 §2 + 08 implicit
**Current behavior**: `src/stores/drafts.ts` persists per-session composer drafts via `window.ccsm.saveState('draft:<sid>', text)` on every keystroke. After Electron restart, drafts are restored — important UX (user types a long prompt, accidentally closes window, reopens, draft is still there).

**Spec behavior**: drafts are renderer-side state, currently stored in `app_state`. Spec §7 §2 says renderer-side state is "ephemeral, deletable any time" and not authoritative. After cutover, drafts either (a) move to localStorage (loses cross-machine for v0.4 web/iOS) or (b) move to daemon settings RPC (no field for it).

**Gap**: Without an explicit decision, drafts silently migrate to "lost on Electron restart" semantics.

**Suggested fix**: spec must call out drafts explicitly. Recommend a `DraftService.GetDraft / UpdateDraft` RPC with per-session storage in daemon DB so v0.4 web/iOS pick up where the user left off — this is a feature today and naturally extends to multi-client.

### P1.5 In-app updater UI deleted; no user-facing update path called out

**Location**: chapter 08 §3 + chapter 10
**Current behavior**: `electron/updater.ts` runs `electron-updater` end-to-end inside the Electron app: status, check, download, install, auto-check toggle. UI lives in Settings.

**Spec behavior**: chapter 10 covers daemon installer round-trip. Updater IPC isn't in chapter 08 mapping. Implicitly the daemon updates via OS service mechanisms (msi, pkg, deb upgrade), and Electron updates separately via electron-updater — but spec is silent on Electron's own update path post-split.

**Gap**: After cutover the existing Settings → "Check for updates" UI is dead unless updater IPC is preserved. If updater IPC is preserved, ship-gate (a) grep fails. If it's deleted, the user has no in-app update prompt and stale Electron clients silently mismatch the daemon (chapter 02 §82 already calls out version mismatch).

**Suggested fix**: chapter 08 must explicitly say (a) updater IPC stays as a sanctioned electron-main-only channel exempt from the lint, OR (b) the renderer fetches update status from a small built-in HTTP endpoint exposed by the main process (same shape as the descriptor injection), OR (c) the update prompt moves entirely to OS-level (no in-app UI). Today's behavior must be preserved or the loss called out.

## P2 findings (defer)

### P2.1 Sentry / crash reporting opt-out has no daemon equivalent

**Location**: `09-crash-collector.md` (daemon-side); `electron/sentry/init.ts` (renderer/electron-main-side)
**Current behavior**: Electron initializes Sentry main + renderer; user can opt out via `crashReporting` pref. Sends to Anthropic's Sentry. Daemon will have its own crash collector (chapter 09).
**Gap**: Two independent crash-reporting systems with separate opt-outs (Sentry network upload vs. local SQLite). Spec says no network upload in v0.3 from daemon, but Electron Sentry continues to send network data. The user's "crashReporting=off" pref must reach both.
**Suggested fix**: chapter 09 should mention that the Electron-side Sentry init reads `Settings.crash_reporting_enabled` (would need to add the field to v0.3 `Settings`) so the user has one toggle that covers both planes. Defer to P2 because Sentry can read its own pref independently in v0.3.

### P2.2 Single-instance lock not addressed

**Location**: `electron/lifecycle/singleInstance.ts` exists today.
**Gap**: With daemon running as service, what happens when the user double-clicks the Electron icon? Today: second instance focuses the existing window. Spec doesn't say.
**Suggested fix**: a one-liner in chapter 08 §4 confirming single-instance lock behavior is preserved.

### P2.3 Context menu in renderer (right-click) uses Electron `Menu` API

**Location**: `electron/window/createWindow.ts` `installContextMenu`
**Gap**: native context menu is an Electron-only API; v0.4 web/iOS will need their own. Spec doesn't acknowledge.
**Suggested fix**: note in chapter 08 §4 that native context menu remains an electron-main-only behavior; web/iOS substitute with HTML-level context menus (additive in v0.4).
