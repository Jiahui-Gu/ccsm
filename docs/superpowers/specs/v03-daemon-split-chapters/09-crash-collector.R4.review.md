# 09 — Crash Collector — R4 (Testability + Ship-Gate Coverage)

## P1 — `crash-raw.ndjson` recovery on boot has no test and is a likely silent-loss path

§2: "On next successful daemon boot, the daemon scans `crash-raw.ndjson`, imports any entries not already in `crash_log` (by id), then truncates the file."

Failure modes the spec doesn't address:
- Partial line at end of file (daemon was killed mid-write of a JSON line) → JSON.parse throws → import aborts → entries lost
- File missing → expected; should not error
- File present but empty → expected; should not error
- File contains malformed entries (non-JSON, missing fields) → spec doesn't say
- Truncation race: if daemon crashes during truncate, file is in indeterminate state

Chapter 12 §3 has `crash-stream.spec.ts` for live capture but no `crash-raw-recovery.spec.ts`. Add one covering all 5 cases.

P1 because this is the "fatal events still surface" safety net; if the safety net itself has silent-loss failure modes, the user loses the most diagnostically-important events (the ones that prevented SQLite writes).

## P1 — Capture sources list (§1) is "exhaustive" but no test asserts every listed source actually has a registered handler

§1 has 11 capture sources. Chapter 12 §2 has `crash/capture.spec.ts — every source's mock fires once and writes one row` — good in principle, but the implementation depends on test author enumerating sources. If the list grows, tests must grow in lockstep. Pin: capture-sources are declared in a single table-driven module (`packages/daemon/src/crash/sources.ts` exports an array); tests iterate that array; spec list and test must derive from same source-of-truth.

## P1 — `sqlite_op` source rate-limiting "one entry per ~60s per code-class" is untested

§1 row: "one entry per ~60s per code-class to prevent flooding." Chapter 12 has no `crash/rate-limit.spec.ts`. A regression that drops the rate limit would flood the crash_log table on a single repeating SQLite error. Add the test.

## P1 — Linux watchdog (§6) `WATCHDOG=1` keepalive is critical to availability and untested

§6: "Daemon main thread emits `WATCHDOG=1` via `systemd-notify` (or equivalent direct socket write) every 10s."

If this regresses (e.g., a refactor moves the keepalive to a worker thread or to a setInterval that gets blocked by a long sync SQLite write), systemd kills the daemon every 30s. Currently a perfect way to discover it is "users report daemon constantly restarting." Add: integration test on linux that runs daemon under simulated systemd (set `NOTIFY_SOCKET` env, listen on a UDS, assert `WATCHDOG=1` arrives every 10±2s for 60s).

## P2 — "Send to Anthropic button is NOT present (not commented out, not behind a flag — it does not exist)" — testable claim

§5 makes a strong testability claim. Add a static check in chapter 12: `grep -F "Send to Anthropic" packages/electron/src/renderer/ && exit 1`. Mirrors the lint:no-ipc gate.

## Summary

P0: 0 / P1: 4 / P2: 1
Most-severe: **The `crash-raw.ndjson` safety-net path has multiple silent-loss failure modes (partial line, malformed entry, truncation race) and no test — the diagnostically-most-important crashes are most likely to be lost.**
