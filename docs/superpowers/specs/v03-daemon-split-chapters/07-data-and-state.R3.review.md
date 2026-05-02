# R3 review — 07-data-and-state

## P0-R3-07-01 — `PRAGMA integrity_check` on boot is mentioned but recovery is silent and lossy

§6 says "daemon on boot runs `PRAGMA integrity_check`. On failure: rename `ccsm.db` → `ccsm.db.corrupt-<ts>`, start fresh with `001_initial.sql`, write a `crash_log` entry (best-effort, may also fail), surface in Settings UI on next Electron connect."

Two reliability holes:

1. "Surface in Settings UI on next Electron connect" but the just-quarantined DB had ALL the user's session history and PTY snapshots. The user loses every session silently. The Electron Settings banner is the only notification — but the user may not open Settings for days. Spec MUST require:
   - A modal-on-launch alert (not a Settings tab item) when the most recent boot quarantined a DB.
   - A `crash_log` entry of source `sqlite_corruption_recovered` (NEW — add to chapter 09 §1) so it shows up in the crash log too.
   - Persisting "recovered from corruption at <ts>" as a settings row so it can be acknowledged.

2. "best-effort, may also fail" for the crash_log entry — the entire reason `crash-raw.ndjson` exists (chapter 09 §2) is for this case. Cross-reference: on integrity_check failure, ALWAYS write to `crash-raw.ndjson` first, before opening the new DB. Currently §6 says "write a crash_log entry" without saying via SQLite or via the raw file.

Without these the most data-destructive event in the system is the most silent.

## P1-R3-07-02 — `PRAGMA wal_checkpoint(TRUNCATE)` only on graceful shutdown

§5: "full `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown only". `PRAGMA wal_autocheckpoint = 1000` runs auto-checkpoints on writes, fine. But on a hard crash (the ship-gate (b) scenario or daemon OOM), the WAL may grow unboundedly between auto-checkpoints. Two sub-issues:

1. WAL file size growth between checkpoints is not capped — long-running sessions with high delta volume can grow the WAL to GBs. Spec should mention `journal_size_limit` PRAGMA.
2. After a hard crash, on next boot, SQLite replays the WAL — but if the daemon is killed mid-WAL-replay (rare but possible), some auto-checkpoint behavior depends on WAL state. Spec should add a startup step: "explicit `PRAGMA wal_checkpoint(RESTART)` after migrations, before opening the application code, to consolidate the WAL into the main DB before starting writes."

## P1-R3-07-03 — Crash on disk-full / I/O error during write coalescer flush is unspecified

§5 describes the write coalescer but says nothing about what happens when an `INSERT INTO pty_delta` throws `SQLITE_FULL` or `SQLITE_IOERR`. R3 angle 6 (disk full) and R3 angle 1 (daemon crash mid-PTY-write):

- Does the failed batch get retried? Dropped? Does the daemon crash the whole process?
- Does the corresponding pty-host worker get notified that its delta wasn't persisted?
- If dropped silently, ship-gate (c) byte-equality fails on next reattach (the lost deltas are not in SQLite to replay).

Chapter 14 §2 residual risks table says "Disk full → SQLite write fails → session state corruption → write coalescer wraps in try/catch; failure → crash_log entry (best-effort) + session state degraded; reads continue from last good row." This belongs IN chapter 07 §5 as normative spec, not in 14 as a residual-risk hand-wave. P1 because the failure mode is real and the current handling is ambiguous.

## P1-R3-07-04 — Electron-side state directory cleanup on uninstall

§2 mentions Electron-side state at `%APPDATA%\ccsm-electron\` etc. Chapter 10 §5 uninstall steps cover daemon state removal but do NOT mention Electron per-user state. On uninstall (per-user prompt), only the daemon state directory is removed — Electron's window-geometry / last-applied-seq cache lingers per user forever. Cross-reference fix in chapter 10 review. P1 (residue but not security risk).

## P2-R3-07-05 — `crash-raw.ndjson` size unbounded

§2 references the file (chapter 09 §2 owns the spec). The file is appended on every fatal event AND scanned + truncated on next successful boot. But: in a crash loop (daemon restarts every 5s, fails to import the file before crashing again), the file grows without bound. Suggest cap (e.g., 10 MiB; oldest entries dropped). Cross-reference to chapter 09 review.

## NO FINDING — migration immutability (§4)

SHA256 lock + CI check is the right discipline.
