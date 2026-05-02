# 09 — Crash Collector

v0.3 captures daemon-side crashes locally to SQLite, exposes them via the `CrashService` RPC, and renders them in the Electron Settings UI. There is no network upload in v0.3 (brief §10). v0.4 adds upload as an additive consumer of the same SQLite table — the capture path is forever-stable. This chapter pins the capture sources, the storage schema, the rotation policy, the surfacing path, and the v0.4 upload-additive contract.

<!-- F1: closes R0 09-P0.1 / R0 09-P0.3 / R5 P0-09-1 — owner_id pinned at v0.3 freeze with daemon-self sentinel; capture-source open-set unified across 04 / 05 / 09 / 15. -->

### 1. Capture sources (v0.3, named — open set)

The daemon registers crash capture handlers at boot, before any RPC handler runs. The list below enumerates the v0.3 named sources but is **NOT exhaustive**: `crash_log.source` is an open string set (see chapter [04](./04-proto-and-rpc-surface.md) §5 `CrashEntry.source`) and v0.4 may add new sources additively without a proto bump or schema change. Chapter [05](./05-session-and-principal.md) §5 and chapter [15](./15-zero-rework-audit.md) §3 reference this same open-set.

| Source | Hook | Severity | What is recorded | Default `owner_id` |
| --- | --- | --- | --- | --- |
| `uncaughtException` | `process.on("uncaughtException", ...)` | fatal | error message, stack, then exit(1) — service manager restarts | `daemon-self` |
| `unhandledRejection` | `process.on("unhandledRejection", ...)` | warn (v0.3) | reason, stack of `Error` if any; daemon does NOT exit (Node's default deprecation behavior is for v0.4 to revisit) | `daemon-self` |
| `claude_exit` | child `exit` event with `code != 0` | warn | exit code, signal, last 4 KiB of stderr ring buffer, session_id | session's `principalKey` |
| `claude_signal` | child `exit` with `signal` set | warn | signal name, session_id | session's `principalKey` |
| `claude_spawn` | child `error` event during `spawn` (binary missing, ENOENT, EACCES) or non-zero `exit` within 500 ms of spawn | warn | session_id, attempted argv, error code | session's `principalKey` |
| `pty_eof` | pty master `close` event when session is `RUNNING` and `should_be_running == 1` | warn | session_id, last 1 KiB of pty output | session's `principalKey` |
| `session_restore` | failure to re-spawn or replay during boot-time session restore (chapter [05](./05-session-and-principal.md) §7) | warn | session_id, restore stage, error | session's `principalKey` |
| `sqlite_open` | `new Database(path)` throws at boot | fatal | path, error code, errno | `daemon-self` |
| `sqlite_op` | any `prepare/run/all` throw | warn | sql (redacted), error code; one entry per ~60s per code-class to prevent flooding | `daemon-self` (or session principalKey if the failing query is session-scoped) |
| `worker_exit` | `worker.on("exit", code)` with `code != 0` for any pty-host worker | warn | session_id, exit code | session's `principalKey` |
| `listener_bind` | `server.listen` error event during startup step 5 | fatal | listener id, bind descriptor, errno | `daemon-self` |
| `migration` | exception during `runMigrations()` | fatal | migration version, error | `daemon-self` |
| `watchdog_miss` | systemd `WATCHDOG=1` not sent in time → daemon receives `SIGABRT` | fatal (captured by signal handler before exit) | uptime at miss | `daemon-self` |

**Source string values** in `crash_log.source` are an **open set**. The names above are the v0.3 baseline; v0.4 (and any v0.3.x patch) may add new sources freely. Clients tolerate unknown values per the [04](./04-proto-and-rpc-surface.md) §5 contract. Chapters [04](./04-proto-and-rpc-surface.md), [05](./05-session-and-principal.md), and [15](./15-zero-rework-audit.md) all reference this same open-set; any chapter that lists sources MUST disclaim exhaustiveness.

**owner_id attribution** (locks the wire field defined in [04](./04-proto-and-rpc-surface.md) §5 `CrashEntry.owner_id` and the column in [07](./07-data-and-state.md) §3 `crash_log.owner_id`):

- Daemon-side crashes that cannot be tied to a specific session (any `sqlite_*`, `listener_bind`, `migration`, `watchdog_miss`, top-level `uncaughtException` / `unhandledRejection`) record `owner_id = "daemon-self"`.
- Session-attributable crashes (`claude_*`, `pty_eof`, `worker_exit`, `session_restore`) record `owner_id` as the session's `principalKey` (e.g., `"local-user:1000"`).
- The sentinel `"daemon-self"` is **NOT** a valid `principalKey` — `principalKey` is always `kind:identifier` with a non-empty kind, and `daemon-self` has no colon. v0.4 cf-access principals never collide.

### 2. Storage schema

Crash entries land in the `crash_log` SQLite table (schema in [07](./07-data-and-state.md) §3). One row per crash event. ULID primary key (lexicographically time-ordered).

For fatal sources where the daemon cannot guarantee a successful SQLite write before exit (e.g., SQLite itself is the source), the daemon also appends a single line of newline-delimited JSON to the **raw crash log file** at `state/crash-raw.ndjson` (per [07](./07-data-and-state.md) §2). The NDJSON line shape is forever-stable; `owner_id` is required and uses the `"daemon-self"` sentinel for daemon-side crashes:

```json
{"id":"01H...","ts_ms":1714600000000,"source":"sqlite_open","summary":"...","detail":"...","labels":{"path":"..."},"owner_id":"daemon-self"}
```

Session-attributable crashes that take the NDJSON path (rare — typically only `worker_exit` if SQLite is also down) carry the session's `principalKey` in `owner_id`. v0.4 may add principal-attributed sources additively without changing the line shape.

On next successful daemon boot, the daemon scans `crash-raw.ndjson`, imports any entries not already in `crash_log` (by id), then truncates the file. This ensures fatal events that prevented SQLite writes still surface to the user post-recovery.

### 3. Rotation and capping

- Cap on entry count: default 10000 rows; exceeding → delete oldest by `ts_ms`.
- Cap on age: default 90 days; exceeding → delete by `ts_ms < now - 90d`.
- Both caps configurable via `Settings.crash_retention` (see [04](./04-proto-and-rpc-surface.md) §6); daemon enforces hard caps `max_entries ≤ 10000`, `max_age_days ≤ 90`.
- Pruner runs at boot and every 6 hours.

### 4. RPC surface

Defined in [04](./04-proto-and-rpc-surface.md) §5:

- `CrashService.GetCrashLog(limit, since_unix_ms, owner_filter)` returns recent entries (newest first), capped at 1000 per call. Pagination implicit via `since_unix_ms` for older windows. `owner_filter` (chapter [04](./04-proto-and-rpc-surface.md) §5) defaults to `OWNER_FILTER_OWN` and filters `crash_log` by `owner_id IN (principalKey(ctx.principal), 'daemon-self')`.
- `CrashService.WatchCrashLog(owner_filter)` server-streams new entries as they land, applying the same `owner_filter` semantics.
- `CrashService.GetRawCrashLog()` (added F6 — closes R0 09-P0.2 / R0 08-P0.1) server-streams the bytes of `state/crash-raw.ndjson` as 64 KiB chunks. Used by the "Download raw log" UI (§5 below). v0.4 web/iOS use this RPC unchanged; the renderer concatenates chunks and persists via the platform's native save mechanism (Electron: File System Access API; v0.4 web: browser save dialog; v0.4 iOS: share sheet).

In v0.3 with a single `local-user` principal, both `OWNER_FILTER_OWN` and `OWNER_FILTER_ALL` return the same effective set (the principal's session-attributable crashes plus all `daemon-self` crashes). v0.4 multi-principal makes the distinction binding: `OWNER_FILTER_ALL` is admin-only. The column, the proto field, and the filter semantics all ship in v0.3 so v0.4 enforcement is a behavior change inside an unchanged surface (see chapter [05](./05-session-and-principal.md) §5 and chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern 14).

### 5. Settings UI surface

<!-- F6: closes R0 09-P0.2 / R5 P1-09-4 ("Open raw log file" → "Download raw log" via GetRawCrashLog); R1 P1.1 (Sentry toggle reads Settings.sentry_enabled). -->

Electron's Settings page renders:

- A table of recent crashes (newest first), columns: time, source, summary. Row click expands to show `detail` (multiline, monospace) and `labels` (key/value chips).
- A counter "X crashes in last 7 days". Clicking filters the table.
- A "Copy as JSON" button per row (renderer-only — copies the displayed payload to clipboard via `navigator.clipboard.writeText`).
- A **"Download raw log"** button that calls `CrashService.GetRawCrashLog`, concatenates the streamed `RawCrashChunk` bytes, and saves to a user-chosen path (Electron: renderer's File System Access API `window.showSaveFilePicker`; v0.4 web: same API; v0.4 iOS: share sheet). Shown unconditionally — daemon scopes the read to its own filesystem (the renderer never touches the daemon-side path). Replaces the previous "Open raw log file" affordance, which depended on `app:open-external` opening a `file://` URL — rejected by chapter [08](./08-electron-client-migration.md) §3.2's URL safety policy AND meaningless in v0.4 web/iOS.
- A **"Send to Sentry"** toggle bound to `Settings.sentry_enabled` (chapter [04](./04-proto-and-rpc-surface.md) §6). Default true (matches v0.2). When false, the Electron-side Sentry init in `packages/electron/src/sentry/init.ts` skips initialization. The daemon's local SQLite crash log (capture path in §1) is independent of this toggle and is always-on. v0.4's "Send to Anthropic" upload UI for the SQLite log will be a sibling toggle (separate boolean, separate consent flow).
- Retention controls bound to `SettingsService.UpdateSettings`.

No network upload UI for the SQLite log in v0.3. The "Send to Anthropic" button (for the daemon's SQLite log) is **not present** (not commented out, not behind a flag — it does not exist). v0.4 adds it as an additive UI element next to the Sentry toggle.

### 6. Watchdog (linux only, v0.3)

Linux systemd unit declares `WatchdogSec=30s`. Daemon main thread emits `WATCHDOG=1` via `systemd-notify` (or equivalent direct socket write) every 10s. **Why on the main thread**: the main thread is what blocks on coalesced SQLite writes; if it hangs, the entire RPC surface is dead. Worker thread liveness is implicit (workers signal via `postMessage`; main checks last-message-age per worker every tick).

Windows / macOS lack a comparable cheap watchdog primitive; v0.3 does NOT implement one (would need a sidecar). Service managers on those platforms restart on process death only. macOS hang detection is **deferred to v0.4 hardening** (see chapter [14](./14-risks-and-spikes.md) — the `[watchdog-darwin-approach]` MUST-SPIKE is removed from the v0.3 spike registry).

#### 6.1 "Crashes since you last looked" badge

<!-- F6: closes R1 P1.2 (chapter 09) — daemon crashes after Electron exit produce no user-visible signal until the user goes looking. Surface a passive count on Settings. -->

The Settings page surfaces a passive count `crashesSinceLastSeen` on the Crash Reporting section header (e.g., "Crash Reporting · **3 new crashes**"). The count is computed by the renderer comparing `WatchCrashLog`'s emitted entries against a renderer-stored `last_seen_crash_id` (persisted via `Settings.ui_prefs["crash.last_seen_id"]`). Opening the Crash Reporting section flushes `last_seen_crash_id` to the most recent entry's id. Cheap addition; converts silent recurring daemon crashes into an in-app passive signal users notice on next launch.

### 6.2 Capture-sources table-driven contract

<!-- F6: closes R4 P1 ch 09 — capture sources declared in a single table-driven module so spec-list and tests derive from the same source-of-truth. -->

The §1 capture-sources table is mirrored in code at `packages/daemon/src/crash/sources.ts` as an exported `const CAPTURE_SOURCES = [...] as const` array. Each entry has `{name: string, severity: 'fatal'|'warn', defaultOwnerId: 'daemon-self'|'session-principal'}`. Tests in `packages/daemon/test/crash/capture.spec.ts` iterate the array and assert one row lands per source under a synthetic-fire harness. Adding a v0.4 source means appending to `CAPTURE_SOURCES`; the test grows automatically. Rate-limiting on the `sqlite_op` source ("one entry per ~60s per code-class to prevent flooding") is exercised by `packages/daemon/test/crash/rate-limit.spec.ts`. Linux watchdog `WATCHDOG=1` keepalive (§6) is exercised by `packages/daemon/test/integration/watchdog-linux.spec.ts` running daemon under a simulated systemd (set `NOTIFY_SOCKET` env, listen on a UDS, assert `WATCHDOG=1` arrives every 10±2s for 60s). Crash-raw recovery silent-loss failure modes are exercised by `packages/daemon/test/crash/crash-raw-recovery.spec.ts` covering: (a) partial line at end of file, (b) file missing, (c) file present but empty, (d) malformed entries (non-JSON, missing fields), (e) truncation race (daemon killed during truncate). All five cases must complete without losing already-imported entries.

> **REMOVED (deferred to v0.4 hardening)**: the previous `[watchdog-darwin-approach]` MUST-SPIKE has been removed from the v0.3 spike registry per dispatch plan §2 F11. macOS hang detection is a v0.4 hardening item.

### 7. v0.4 delta

- **Use** existing `crash_log.owner_id` column (already `NOT NULL` from v0.3 with `'daemon-self'` sentinel — see chapter [07](./07-data-and-state.md) §3) — v0.4 starts populating attributable principalKeys for cf-access sessions; no schema change.
- **Add** `crash_log.uploaded_at INTEGER NULL` column for upload tracking. Existing rows valid (NULL = never uploaded).
- **Add** `CrashService.UploadCrashLog(...)` RPC (or a separate `CrashUploadService`) — additive RPC.
- **Add** "Send to Anthropic" UI in Settings; toggleable; defaults off.
- **Add** Windows / macOS watchdog implementations as additive sidecars or in-process timers.
- **Add** new capture sources additively (the v0.3 list in §1 is explicitly an open set, not exhaustive).
- **Unchanged**: `crash_log.owner_id` column shape, `OwnerFilter` enum semantics in `GetCrashLog` / `WatchCrashLog`, NDJSON line shape (including `owner_id` field with `"daemon-self"` sentinel), `crash_log` baseline schema, `crash-raw.ndjson` import-on-boot recovery, RPC names and signatures listed in §4, Settings UI table layout (v0.4 adds rows / buttons but does not reshape).
