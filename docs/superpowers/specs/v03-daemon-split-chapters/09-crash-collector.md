# 09 — Crash Collector

v0.3 captures daemon-side crashes locally to SQLite, exposes them via the `CrashService` RPC, and renders them in the Electron Settings UI. There is no network upload in v0.3 (brief §10). v0.4 adds upload as an additive consumer of the same SQLite table — the capture path is forever-stable. This chapter pins the capture sources, the storage schema, the rotation policy, the surfacing path, and the v0.4 upload-additive contract.

### 1. Capture sources (v0.3, exhaustive)

The daemon registers crash capture handlers at boot, before any RPC handler runs:

| Source | Hook | Severity | What is recorded |
| --- | --- | --- | --- |
| Daemon `uncaughtException` | `process.on("uncaughtException", ...)` | fatal | error message, stack, then exit(1) — service manager restarts |
| Daemon `unhandledRejection` | `process.on("unhandledRejection", ...)` | warn (v0.3) | reason, stack of `Error` if any; daemon does NOT exit (Node's default deprecation behavior is for v0.4 to revisit) |
| `claude` CLI subprocess exit, non-zero | child `exit` event with `code != 0` | warn | exit code, signal, last 4 KiB of stderr ring buffer, session_id |
| `claude` CLI subprocess exit by signal | child `exit` with `signal` set | warn | signal name, session_id |
| PTY EOF unexpected | pty master `close` event when session is `RUNNING` and `should_be_running == 1` | warn | session_id, last 1 KiB of pty output |
| SQLite open error | `new Database(path)` throws at boot | fatal | path, error code, errno |
| SQLite operational error | any `prepare/run/all` throw | warn | sql (redacted), error code; one entry per ~60s per code-class to prevent flooding |
| Worker thread exit | `worker.on("exit", code)` with `code != 0` for any pty-host worker | warn | session_id, exit code |
| Listener bind failure | `server.listen` error event during startup step 5 | fatal | listener id, bind descriptor, errno |
| Migration failure | exception during `runMigrations()` | fatal | migration version, error |
| Service watchdog miss (linux) | systemd `WATCHDOG=1` not sent in time → daemon receives `SIGABRT` | fatal (captured by signal handler before exit) | uptime at miss |

**Source string values** in `crash_log.source` are the open string set defined in [04](./04-proto-and-rpc-surface.md) §5: `"uncaughtException" | "unhandledRejection" | "claude_exit" | "claude_signal" | "pty_eof" | "sqlite_open" | "sqlite_op" | "worker_exit" | "listener_bind" | "migration" | "watchdog_miss"`. New sources added freely; clients tolerate unknown.

### 2. Storage schema

Crash entries land in the `crash_log` SQLite table (schema in [07](./07-data-and-state.md) §3). One row per crash event. ULID primary key (lexicographically time-ordered).

For fatal sources where the daemon cannot guarantee a successful SQLite write before exit (e.g., SQLite itself is the source), the daemon also appends a single line of newline-delimited JSON to the **raw crash log file** at `state/crash-raw.ndjson` (per [07](./07-data-and-state.md) §2). Format:

```json
{"id":"01H...","ts_ms":1714600000000,"source":"sqlite_open","summary":"...","detail":"...","labels":{"path":"..."}}
```

On next successful daemon boot, the daemon scans `crash-raw.ndjson`, imports any entries not already in `crash_log` (by id), then truncates the file. This ensures fatal events that prevented SQLite writes still surface to the user post-recovery.

### 3. Rotation and capping

- Cap on entry count: default 10000 rows; exceeding → delete oldest by `ts_ms`.
- Cap on age: default 90 days; exceeding → delete by `ts_ms < now - 90d`.
- Both caps configurable via `Settings.crash_retention` (see [04](./04-proto-and-rpc-surface.md) §6); daemon enforces hard caps `max_entries ≤ 10000`, `max_age_days ≤ 90`.
- Pruner runs at boot and every 6 hours.

### 4. RPC surface

Defined in [04](./04-proto-and-rpc-surface.md) §5:

- `CrashService.GetCrashLog(limit, since_unix_ms)` returns recent entries (newest first), capped at 1000 per call. Pagination implicit via `since_unix_ms` for older windows.
- `CrashService.WatchCrashLog()` server-streams new entries as they land.

Both are open to any local-user principal in v0.3 (single principal). v0.4 may add an `owner_id` filter (see [05](./05-session-and-principal.md) §5 and [15](./15-zero-rework-audit.md)).

### 5. Settings UI surface

Electron's Settings page renders:

- A table of recent crashes (newest first), columns: time, source, summary. Row click expands to show `detail` (multiline, monospace) and `labels` (key/value chips).
- A counter "X crashes in last 7 days". Clicking filters the table.
- A "Copy as JSON" button per row (renderer-only — copies the displayed payload to clipboard).
- A "Open raw log file" button (renderer-only — uses the `app:open-external` replacement to open the daemon's `crash-raw.ndjson` path; shown only on platforms where the user has read access).
- Retention controls bound to `SettingsService.UpdateSettings`.

No network upload UI in v0.3. The "Send to Anthropic" button is **not present** (not commented out, not behind a flag — it does not exist). v0.4 adds it as an additive UI element.

### 6. Watchdog (linux only, v0.3)

Linux systemd unit declares `WatchdogSec=30s`. Daemon main thread emits `WATCHDOG=1` via `systemd-notify` (or equivalent direct socket write) every 10s. **Why on the main thread**: the main thread is what blocks on coalesced SQLite writes; if it hangs, the entire RPC surface is dead. Worker thread liveness is implicit (workers signal via `postMessage`; main checks last-message-age per worker every tick).

Windows / macOS lack a comparable cheap watchdog primitive; v0.3 does NOT implement one (would need a sidecar). Service managers on those platforms restart on process death only.

> **MUST-SPIKE [watchdog-darwin-approach]**: hypothesis: launchd can be configured to restart on QueueDirectories or KeepAlive=Crashed to mimic systemd watchdog behavior; or we can use a periodic launchd `OnDemand` check. · validation: instrument a hang and verify launchd restarts within 60s. · fallback: live without; document as a v0.4 hardening item; do NOT block ship.

### 7. v0.4 delta

- **Add** `crash_log.owner_id` column (additive, default NULL = global). Existing rows valid.
- **Add** `crash_log.uploaded_at INTEGER NULL` column for upload tracking. Existing rows valid (NULL = never uploaded).
- **Add** `CrashService.UploadCrashLog(...)` RPC (or a separate `CrashUploadService`) — additive RPC.
- **Add** "Send to Anthropic" UI in Settings; toggleable; defaults off.
- **Add** Windows / macOS watchdog implementations as additive sidecars or in-process timers.
- **Unchanged**: capture sources list (v0.4 adds new sources freely; format unchanged), `crash_log` baseline schema, `crash-raw.ndjson` import-on-boot recovery, RPC names and signatures listed in §4, Settings UI table layout (v0.4 adds rows / buttons but does not reshape).
