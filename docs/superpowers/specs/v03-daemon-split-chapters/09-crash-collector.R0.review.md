# R0 (zero-rework) review of 09-crash-collector.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 `crash_log` lacks `owner_id` from day one — v0.4 add-with-NULL leaks across principals

**Location**: `09-crash-collector.md` §1, §2; `15-zero-rework-audit.md` row "[09 §1]" v0.4 delta
**Issue**: Same root cause as `07-data-and-state.R0.review.md` P0.1 and `05-session-and-principal.R0.review.md` P0.1: the v0.3 schema omits `owner_id`, the audit chapter calls v0.4 add additive with default NULL, but NULL = "global" means existing `local-user`-attributed crash entries become visible to all v0.4 cf-access principals. PRIVACY REGRESSION + RPC semantic change of `GetCrashLog`.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 SQLite schema column whose semantics differ once cf-access principals exist".
**Suggested fix**: See `07-data-and-state.R0.review.md` P0.1. In `001_initial.sql` ship `crash_log.owner_id TEXT NOT NULL`, populated from `principalKey(ctx.principal)` for caller-attributed sources OR a sentinel `"daemon-self"` for daemon-internal sources. Lock the sentinel string in chapter 09 §1 alongside the source open-set.

### P0.2 "Open raw log file" UI affordance has no working transport in v0.4 (and arguably not in v0.3)

**Location**: `09-crash-collector.md` §5
**Issue**: §5 says the Settings UI exposes "Open raw log file" via the `app:open-external` replacement. In `08-electron-client-migration.md` §3, `app:open-external` is mapped to renderer `window.open(url, '_blank')` for **`https?://` only — other schemes rejected**. A `file://` to `crash-raw.ndjson` is rejected. So the affordance is broken in v0.3. In v0.4 web/iOS, opening a daemon-side filesystem path is meaningless (the file lives on the daemon's host, not the client's). The v0.4 fix must be a server-side RPC that streams the file's contents — and that RPC must exist in v0.3 to satisfy the additivity contract.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 Electron-specific code path that web/iOS can't replicate". Also, the v0.3 affordance as documented does not work — see `08-electron-client-migration.R0.review.md` P0.1.
**Suggested fix**: Add to v0.3 `crash.proto`:
```proto
service CrashService {
  // ...existing RPCs...
  rpc GetRawCrashLog(GetRawCrashLogRequest) returns (stream RawCrashChunk);
}
message GetRawCrashLogRequest { RequestMeta meta = 1; }
message RawCrashChunk { bytes data = 1; bool eof = 2; }
```
v0.3 Electron Settings UI replaces "Open raw log file" with "Download raw log" (button triggers RPC, saves to user-chosen path via the renderer's File System Access API or similar). v0.4 web/iOS use the same RPC unchanged.

### P0.3 NDJSON `crash-raw.ndjson` "import on next boot" assumes daemon-self attribution but never says so; collides with v0.4 owner-scoped reads

**Location**: `09-crash-collector.md` §2 (raw NDJSON recovery file)
**Issue**: When the daemon catches a fatal source whose SQLite write may fail (e.g., `sqlite_open`), it writes a JSON line to `crash-raw.ndjson`; on next boot it imports unmatched ids. The JSON shape shown in §2 has no `owner_id` field. After the v0.3 P0.1 fix (add `owner_id NOT NULL` to `crash_log`), the import-on-boot path must populate `owner_id` for these orphan rows. There IS no caller principal at that moment — the daemon spawned the entry before any RPC happened. v0.4 with cf-access principals reading via Listener B will see these "boot-time" entries OR not, depending on the import logic. The spec doesn't pin it.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 daemon-side state keyed by something Electron-specific that doesn't generalize" — the absence of an owner field IS a single-tenant assumption.
**Suggested fix**: Lock the NDJSON line shape in v0.3 to include `"owner_id": "daemon-self"` for every entry written via the raw safety net path. Lock that on v0.4 boot, raw-import sets `owner_id = "daemon-self"` for any imported row missing the field. Document `"daemon-self"` as the universal sentinel that means "visible to admin principals only" in v0.4 (and visible to local-user in v0.3 because there is no admin filter yet).

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 Watchdog only on Linux in v0.3; Win/Mac liveness silently absent

**Location**: `09-crash-collector.md` §6; `15-zero-rework-audit.md` author sub-decision item — implicit
**Issue**: Linux gets `WatchdogSec=30s` via systemd. Windows / macOS get nothing in v0.3 ("Service managers on those platforms restart on process death only"). v0.4 hardening adds them. Zero-rework: v0.4 watchdogs are additive — fine. But: a hung daemon on win/mac during v0.3 dogfood ship-gate (b)/(c) testing would cause silent failure (the daemon is still "running" from the OS service manager's POV but RPCs don't respond). Ship-gate (b) only kills Electron, not the daemon, so wouldn't catch this. Ship-gate (c) is a 1-hour soak — would catch a hang as a stalled stream, escalating reviewer attention to "v0.3 ship is partly blind on win/mac".
**Why P1**: Soft v0.4 additive-OK; v0.3 ship hygiene flag.
**Suggested fix**: Add a v0.3 in-daemon self-check: every 10s the main thread writes `state/heartbeat.txt` with `mtime = now`. A separate tiny supervisor binary (per-OS) reads heartbeat mtime; if > 60s, it kills the daemon. Optional in v0.3, recommended; v0.4 replaces with native watchdogs additively.

### P1.2 `crash_log.summary`/`detail` are unbounded TEXT; one giant stack could blow row size

**Location**: `09-crash-collector.md` §1, §3 (rotation by count/age but not by size)
**Issue**: A pathological `unhandledRejection` with a 100MB JSON-stringified payload as `detail` would single-handedly bloat the DB. v0.3 dogfood probably won't hit it; v0.4 multi-tenant with hostile principals could. Rotation as written doesn't size-cap.
**Why P1**: Soft-rework / hardening; not a wire-shape change. v0.4 can add a size cap as additive setting.
**Suggested fix**: In §1's source-handler code, truncate `detail` to 64 KiB at capture time with a `…[truncated]` suffix. Lock this in v0.3 so rows are bounded forever.

### P1.3 `claude` CLI subprocess crash captures "last 4 KiB of stderr ring buffer" but ring isn't specified

**Location**: `09-crash-collector.md` §1 (claude_exit non-zero row)
**Issue**: Implementation detail: where does the ring live? Per-session stderr capture means a per-session 4 KiB buffer maintained by the daemon (+RAM cost × N sessions) OR by the pty-host worker (then how does main thread access it on crash?). v0.4 doesn't change this but vagueness invites divergent implementations.
**Why P1**: Implementation gap.
**Suggested fix**: Pin in §1: ring lives in the pty-host worker; on `claude` exit the worker `postMessage`s `{kind: "stderr-tail", sessionId, bytes}` to main; main writes the `crash_log` row including the bytes (truncated to 4 KiB).
