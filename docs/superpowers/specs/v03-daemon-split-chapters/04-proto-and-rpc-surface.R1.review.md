# R1 (feature-preservation) review of 04-proto-and-rpc-surface.md

This chapter freezes the v0.3 wire schema. The forever-stable contract makes any omission very expensive: a feature missing here cannot be silently added in v0.4 — the corresponding RPC must be added (additive is fine), but the v0.3 product will ship without it. The chapter's RPC inventory covers session lifecycle, PTY, crash log, settings — but the current Electron app exposes far more user-visible behavior than that. Feature-preservation findings here are upstream of the chapter-08 mapping problem (see `08-electron-client-migration.R1.review.md`); the proto must grow first or the mapping cannot be 1:1.

## P0 findings (block ship; user-visible feature drops or breaks)

### P0.1 SessionService missing rename / SDK info / importable scan / pending-rename queue

**Location**: §3 `SessionService`
**Current behavior** (`electron/sessionTitles/index.ts`, `electron/import-scanner.ts`):
- The Sidebar lets the user rename a session — backed by `@anthropic-ai/claude-agent-sdk`'s `renameSession`.
- The Sidebar shows SDK-derived summaries — backed by `getSessionInfo` (per-sid 2s TTL cache, ENOENT classification).
- Project view lists sessions for a project — `listSessions(projectKey)`.
- Pending rename queue: when `renameSession` returns `no_jsonl` (JSONL not yet present because the session just started), the rename is queued in main-process memory and flushed by the JSONL tail watcher when the file appears (PR2/PR3 of the sessionTitles work).
- "Import existing claude session" UI — `electron/import-scanner.ts` walks `~/.claude/projects/*` and returns importable sessions with `{sessionId, cwd, title, mtime, projectDir, model}`.

**Spec behavior**: `SessionService` has only `Hello / ListSessions / GetSession / CreateSession / DestroySession / WatchSessions`. None of the above are representable.

**Gap**: All five features become non-functional in v0.3. Renaming, SDK titles, project-scoped lists, the pending-rename robustness, and the entire import flow vanish. v0.4 may add the RPCs additively but v0.3 ships without them — a hard regression.

**Suggested fix**: add to `session.proto`:

```
rpc RenameSession(RenameSessionRequest) returns (RenameSessionResponse);
rpc GetSessionTitle(GetSessionTitleRequest) returns (GetSessionTitleResponse);
rpc ListProjectSessions(ListProjectSessionsRequest) returns (ListProjectSessionsResponse);
rpc ListImportableSessions(ListImportableSessionsRequest) returns (ListImportableSessionsResponse);
rpc ImportSession(ImportSessionRequest) returns (ImportSessionResponse);
```

(or a `ClaudeSdkService` if you prefer separation). The pending-rename queue is an internal implementation detail; from the wire's POV `RenameSession` simply returns `{ok|deferred|failed}`.

### P0.2 Notify pipeline (toast / badge / flash / OSC-title decider) has no RPC

**Location**: chapter 04 has no `NotifyService`
**Current behavior** (`electron/notify/*`, `electron/sessionWatcher/*`, `electron/notify/notifyDecider.ts`):
- 7-rule decider mapping (event, ctx) → toast+flash decisions
- OS toasts (Windows toast / macOS NSUserNotification / Linux libnotify)
- App-icon badge with unread count (`electron/notify/badge.ts`)
- AgentIcon halo flash signal pushed to renderer (`notify:flash`)
- JSONL tail watcher infers `idle | running | requires_action` per session
- OSC-title parser drives notify trigger
- Click-toast-to-focus feedback loop (`session:activate` push)

**Spec behavior**: silence. PtyService streams raw VT bytes only; no semantic state inference exposed. SessionEvent.updated mentions "state, exit_code, geometry change" but `state` here is `SESSION_STATE_*` (STARTING/RUNNING/EXITED/CRASHED) — coarser than the notify decider's `idle | running | requires_action` state machine.

**Gap**: After cutover the notify pipeline cannot be reconstituted from the existing wire surface — the client gets PTY bytes and only the coarse SessionState. The 7-rule decider and all OS notification UX are lost.

**Suggested fix**: add either (a) a `NotifyService` running in the daemon (the daemon has the JSONL watcher and PTY data; only `focused` and `activeSid` need to flow client → daemon) with `WatchNotifyEvents() returns (stream NotifyEvent)`, plus `MarkUserInput(sid)` / `SetActiveSid(sid)` / `SetFocused(bool)` setters; or (b) expose enough raw signals (parsed OSC titles, run-start/end events) so the client can run the decider locally — this is the way to keep daemon dumb but pushes more state into clients. Either way: the wire surface must carry enough information for the toast/badge/flash UX.

### P0.3 PtyService missing clipboard, claude-binary detection, list-PTY (administrative)

**Location**: §4 `PtyService`
**Current behavior**:
- `pty:checkClaudeAvailable` (`electron/ptyHost/ipcRegistrar.ts:186`) probes whether the `claude` CLI is on PATH and resolves its absolute path. Renderer surfaces "Claude CLI not found, install it" UX. Distinct from `Settings.claude_binary_path` because that's an *override*, not a "where is it" query.
- `pty:list` returns the in-process PTY map (debug-ish; appears in `electron/ptyHost`).
- `pty:get(sid)` returns a single PTY's state.
- Clipboard: `electron/preload/bridges/ccsmPty.ts` exposes `clipboard.readText / writeText` directly via Electron's `clipboard` module — used by terminal pane for copy/paste.

**Spec behavior**: `PtyService` has Attach / SendInput / Resize. No claude-binary probe, no clipboard.

**Gap**:
- "Claude CLI not found" UX (the user-friendly install banner) silently breaks; the user gets a session that immediately exits with a confusing `claude_exit` crash entry instead.
- Clipboard: `contextBridge` is being deleted entirely (chapter 08 §1) but the renderer's `clipboard.readText/writeText` calls live behind it. After cutover terminal copy/paste is broken. (Web/iOS get clipboard from browser/native APIs, but v0.3 Electron is currently going through `contextBridge` and there's no explicit replacement.)

**Suggested fix**: add `PtyService.CheckClaudeAvailable() returns (CheckClaudeAvailableResponse {bool available, string path})` (forever-stable: web/iOS clients in v0.4 can hit this against their daemon to know if claude is installed). For clipboard, chapter 08 §4 should explicitly note that clipboard remains a renderer-side concern via `navigator.clipboard.*` (Chromium supports it under https / loopback contexts) and that no `contextBridge` clipboard surface ships.

### P0.4 SettingsService doesn't cover per-renderer prefs OR per-CLI defaults

**Location**: §6 `Settings` message
**Current behavior**:
- `app_state` SQLite table holds: theme, fontSize, fontSizePx, sidebar width, drafts (per-session), closeAction, notifyEnabled, crashReporting opt-out, user-cwds LRU, updater auto-check, language, etc.
- `settings:defaultModel` (`electron/ipc/systemIpc.ts:55`) reads the user's `~/.claude/settings.json` `model` field — used to seed the new-session model picker so ccsm matches the standalone CLI's default.
- `app:userHome` (`os.homedir()`).

**Spec behavior**: `Settings` has `claude_binary_path`, `default_geometry`, `crash_retention`. That's it.

**Gap**:
- Theme/font/closeAction/notifyEnabled/language all have no RPC home.
- Default-model auto-detection from `~/.claude/settings.json` has no RPC home.
- `os.homedir()` for default-cwd fallback has no RPC home (spec uses `cwd` as required field on `CreateSessionRequest` but never says how the client knows what cwd to default to).

**Suggested fix**: extend `Settings` to be a flexible bag (e.g., `map<string, string> ui_prefs`) OR add a separate `AppStateService` with `Get(key)/Set(key,value)/List(prefix)` semantics matching today's `db:load/save` directly. Add `Settings.detected_claude_default_model` (read-only, daemon fills) and `Settings.user_home_path` (read-only) so clients can seed defaults. All forever-stable from day one.

### P0.5 No service for window-control / system-locale / app-version / open-external

**Location**: chapter 04 entirely
**Current behavior**: handled by `windowIpc`, `systemIpc`. `app:getVersion`, `ccsm:get-system-locale`, `ccsm:set-language`, window controls.

**Spec behavior**: chapter 08 §3 says `app:version` is bundled at build time and `app:open-external` is `window.open`. Chapter 04 says nothing. `ccsm:set-language` (renderer pushing UI lang to main so notifications match) has no story.

**Gap**: 
- App version: today, `app.getVersion()` reads from electron's `package.json` via main; bundling at build time works for Electron renderer but the daemon has no way to expose its own version unless the spec adds it (Hello returns daemon_version, OK), but ELECTRON's version is not the same and used in version-mismatch dialog.
- Locale/language: daemon needs to know UI language to format toast text (since toasts originate in daemon now, per P0.2). Currently solved by renderer→main push; spec has no replacement.

**Suggested fix**: `Settings.locale` (forever-stable, client→daemon push) so the daemon knows what language to use for toasts and OS notifications. Spec must also explicitly note where Electron's own version comes from (build-time constant is fine; just say it).

## P1 findings (must-fix; UX regression or silent migration)

### P1.1 SessionEvent.updated has no field-mask — clients can't tell what changed

**Location**: §3 `SessionEvent`
**Current behavior**: today's renderer subscribes to per-channel signals (`session:state`, `session:title`, `session:cwdRedirected`) which are typed and granular.
**Spec behavior**: `SessionEvent.updated = Session` carries the whole snapshot; no indication of which field changed.
**Gap**: Renderer must diff manually; high-frequency state churn (running ↔ idle 100ms apart) sends entire Session blobs over the wire. Performance regression for v0.4 web client over CF Tunnel especially.
**Suggested fix**: add `Session changed_fields_mask` as forever-stable from day one, OR split `SessionEvent.updated` into multiple typed events.

### P1.2 CreateSession requires `claude_args` and `env` but client has no way to discover daemon's defaults

**Location**: §3 `CreateSessionRequest`
**Current behavior**: today, `pty:spawn` takes only sid+cwd; main process resolves the claude binary path and assembles default args based on user prefs (default model, etc.).
**Spec behavior**: client must pass `claude_args`, `env`, `cwd`, `initial_geometry`. No defaults RPC.
**Gap**: Every client (v0.3 Electron, v0.4 web, v0.4 iOS) duplicates the assembly logic. A version skew where one client knows about a new arg flag but another doesn't — silent UX divergence.
**Suggested fix**: either daemon owns args entirely (`CreateSessionRequest` carries semantic intents like `model_override`, `permission_mode`) and renderer is dumb, OR add a `SessionService.GetCreateDefaults() returns (CreateSessionDefaults)` so all clients seed identically.

### P1.3 PtyDelta payload type allows raw VT bytes only — no structured events

**Location**: §4 `PtyDelta`
**Current behavior**: today's `pty:data` carries `{sid, chunk, seq}` but ALSO emits OSC-title parsing as a side-channel (`session:title`), and the JSONL watcher emits `session:state`. Daemon has all signals; spec only ships raw bytes downstream.
**Spec behavior**: snapshot+delta+heartbeat. Anything semantic (parsed OSC, JSONL state) is gone.
**Gap**: Notify pipeline (P0.2 above) loses its triggers. Client must re-parse OSC from raw bytes — but the daemon already does this for its own notify decider; duplicating in client is wasteful.
**Suggested fix**: extend `PtyFrame` oneof with `PtyEvent event = 4;` carrying `{kind: OSC_TITLE | OSC_BELL | ..., payload}`. Forever-stable; v0.4 adds new event kinds additively.

## P2 findings (defer)

### P2.1 No `Hello` echoing of `principal_uid` for client-side caching

The client gets `principal` in HelloResponse but it's a heavy oneof; for the common path (single-user dev box) the client just wants to label the UI "logged in as <user>". Minor — the current `display_name` field already does this. P2 deferral.

### P2.2 No batched `SendInput` for IME composition

Today, IME composition produces multi-byte sequences best sent atomically. Unary RPC per keystroke is fine over loopback but IME flushes multi-keystroke bursts; consider a `SendInputBatch` for v0.5. The current `bytes data` is variable-length so a client CAN buffer-and-flush, but the spec doesn't say. P2 documentation note.
