# R3 review — 09-crash-collector

## P0-R3-09-01 — No structured logging spec at all

R3 angle 16 + 20. The chapter specifies a CRASH log (one row per fault) but the spec has no general-purpose LOG (per-RPC, per-event, per-decision). Operators debugging "why did session X get a snapshot at t=12:34" or "why did Listener A return UNAVAILABLE at t=12:35" have nothing to look at. The crash log only records faults; normal operation is invisible.

Specifically missing from the entire spec (this chapter is the right home):

1. **Log format**: pin ndjson with required fields `{ts, level, component, sessionId?, principalKey?, requestId?, msg, err?}`. `requestId` cross-references `RequestMeta.request_id` from chapter 04 §2 — already exists in proto, just needs to flow into logs.
2. **Log levels**: pin a minimal set (`debug | info | warn | error`) and a default level (`info`).
3. **Log destinations per OS**:
   - Linux: stdout (systemd journal captures); also `/var/log/ccsm/daemon.log` rotated by logrotate / size cap.
   - macOS: `/Library/Logs/ccsm/daemon.log` (Apple convention) + stdout (launchd captures via `StandardOutPath` if configured — chapter 02 §2.2 doesn't mention).
   - Windows: `%PROGRAMDATA%\ccsm\logs\daemon.log` (NOT Event Log — too small, hard to query); rotated.
4. **Log rotation**: size-based (e.g., 10 MiB × 5 files) — pin policy or pick a library (`pino` rotation, `winston-daily-rotate-file`, or in-house).
5. **Electron-side log location** parallel to daemon (currently entirely unspecified).

Without this, the daemon is undebuggable in production. Adding "use console.log" is not acceptable — there's no rotation, no level filtering, no structured fields, and on Windows nothing is captured at all.

This is the single most-severe R3 finding. Suggest a new sub-chapter or a §7 "Logging" addition to chapter 09 (since both fault-capture and normal-log are operator-visibility concerns).

## P0-R3-09-02 — No metrics surface at all

R3 angle 17. The daemon has no `/metrics` endpoint (Prometheus / OpenMetrics / plain JSON dump). The user cannot answer "is my PTY slow because the snapshot encoder is slow, or because SQLite is slow, or because the worker is slow?" without strace.

Even local-only, basic counters/histograms would suffice:
- `ccsm_pty_delta_bytes_total{session_id}`
- `ccsm_pty_snapshot_duration_ms` (histogram)
- `ccsm_sqlite_write_duration_ms` (histogram)
- `ccsm_listener_a_active_streams`
- `ccsm_pty_input_buffered_bytes{session_id}` (pairs with R3-06-01 backpressure cap)
- `ccsm_crash_total{source}`

Expose via Supervisor UDS as `GET /metrics` (Prometheus text format — no new deps if implemented manually; ~50 LOC). Forever-stable URL. Zero v0.4 cost.

P0 because the brief's ship-gate (c) is a 1-hour soak — without metrics, regressions show up only as the final pass/fail bit; you can't bisect a soak failure to "snapshot encode got slower at t=42min" vs "SQLite got slow because WAL grew" vs "claude CLI started outputting more". This makes the spike + the soak much weaker than they could be.

## P1-R3-09-03 — Capture sources missing from §1 list

R3 angle 19 (audit chapter 09 vs every R3 failure mode):

Missing sources (chapter 09 §1 should add):
- `pty_input_overflow` — per R3-06-01 backpressure cap.
- `pty_snapshot_write` — per R3-06-02 disk-full snapshot.
- `sqlite_corruption_recovered` — per R3-07-01 integrity_check failure.
- `descriptor_write_fail` — per R3-03-02 descriptor file write atomicity.
- `bridge_crash` (if main-process bridge is shipped — per R3-08-03).

Chapter 09 §1 calls out the list as "exhaustive" (line 5). It is not, against the failure modes specified elsewhere. Either add these or remove the "exhaustive" claim.

## P1-R3-09-04 — Watchdog source captured but signal-handler write path not specified

§6 describes systemd watchdog. The capture row in §1 is "Service watchdog miss (linux) ... captured by signal handler before exit". But chapter 02 §2.3 doesn't specify the signal handler is installed, and async-signal-safe code in Node is extremely limited — calling SQLite or even most JS from a signal handler is not safe. The realistic path is:

- Signal handler writes a single fixed-format line to `crash-raw.ndjson` via raw `fs.writeSync` (one of the few async-signal-safe Node APIs), then exits.

Spec should pin this explicitly because the implementer will otherwise try to use the SQLite path and fail silently.

## P1-R3-09-05 — `crash-raw.ndjson` size unbounded (cross-ref R3-07-05)

§2 spec for `crash-raw.ndjson` import-on-boot says "imports any entries not already in `crash_log` (by id), then truncates the file." Good — but a CRASH LOOP (daemon dies before successful boot completes) keeps appending; file grows forever. Cap (e.g., 10 MiB; rotate to `.old` then truncate) needed.

## P2-R3-09-06 — `WatchCrashLog` resume cursor unspecified

`WatchCrashLog` (chapter 04 §5) takes no since cursor — on reconnect, server emits ??? (all of history? only new? from connection time?). Spec doesn't say. Pair with R3-08-01.
