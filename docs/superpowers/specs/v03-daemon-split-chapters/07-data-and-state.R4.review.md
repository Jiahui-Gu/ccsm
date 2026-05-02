# 07 — Data and State — R4 (Testability + Ship-Gate Coverage)

## P0 — Migration immutability via SHA256 lock (§4) — script doesn't exist in spec, no failure-mode test

§4: "a SHA256 of `001_initial.sql` is committed as a constant in `packages/daemon/src/db/migrations/locked.ts`; CI compares."

Chapter 12 §2 lists `db/migrations.spec.ts` (apply 001 to `:memory:`, assert schema). NOT a SHA-lock test. The locked.ts mechanism is mentioned but not specified:
- Where does the SHA come from on first commit? (chicken-and-egg: code references SHA of file in same commit)
- What does the CI compare look like? `node -e "assert(sha256(read('001')) === LOCK)"`?
- What error does CI emit on mismatch?

Without spec + test, the lock is "eventually we'll add it" — and chapter 13 §2 phase 3 doesn't list it as an exit criterion either. Pin the script + add `db/migration-lock.spec.ts` that fails if `001_initial.sql` SHA != `locked.ts.MIGRATION_001_SHA`.

P0 because chapter 15 §3 forbidden-pattern #4 ("Modifying any v0.3 SQL migration file") relies on this enforcement; no enforcement = forbidden pattern is theatre.

## P0 — Corrupt-DB recovery (§6) has no test

§6: "On failure: rename `ccsm.db` → `ccsm.db.corrupt-<ts>`, start fresh with `001_initial.sql`, write a `crash_log` entry."

Chapter 12 has no test for this. Trivial to test: write a deliberately-corrupt SQLite file (truncate header, or zero-fill page 1), boot daemon, assert: rename happens, fresh DB created, crash log entry written, daemon transitions to ready. Without this test, the "best-effort, may also fail" path could regress to "boot loops on corrupt DB" silently. Add `db/integrity-check-recovery.spec.ts`.

P0 because corrupt-DB is a real failure mode (laptop sleep+power-loss) and the recovery path is what stands between user and "all sessions gone forever, daemon won't boot."

## P1 — WAL checkpoint discipline (§5) has no test

§5: "WAL checkpoint: `PRAGMA wal_autocheckpoint = 1000`; full `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown only."

No test asserts:
- A crash mid-write doesn't lose more than the most-recent uncommitted txn
- Graceful shutdown fully truncates WAL (so the file isn't ballooning forever)
- WAL not truncated on ungraceful shutdown (spec implies this is fine)

Add `db/wal-discipline.spec.ts`.

## P1 — Write coalescer (§5): `BetterQueue` mention is the only spec; no test for ordering/backpressure

§5: per-session delta batches via "BetterQueue keyed by session ... 16 ms tick flushes per-session delta batches as one INSERT prepared statement repeated inside one IMMEDIATE transaction."

Chapter 12 §2 has `db/coalescer.spec.ts — write batching ordering and atomicity`. Good. But what about backpressure: if SQLite write is slow, the queue grows; at what size does the daemon shed load (and how)? Chapter 06 §6 says "if subscriber falls outside retention window, daemon closes stream" — that's the read side; the write-coalescer side has no shed-load story. Pin and test: queue cap → drop oldest? block emitter? OOM? Without it, SQLite write slowness silently grows daemon RSS until OOM-kill.

## P1 — `PRAGMA integrity_check` is run on boot but result interpretation is unspecified

§6: "daemon on boot runs `PRAGMA integrity_check`. On failure: rename ..."

`PRAGMA integrity_check` returns "ok" on success, otherwise a list of issues. "Failure" isn't binary — it could return non-fatal warnings. Spec must define: any non-"ok" → treat as failure → rename. Pin.

## P1 — `cwd_state` table tracks "last known cwd" but the update path is unspecified

§3: cwd_state's `cwd` updated by ??? The schema is defined but no spec section says HOW cwd is captured (parsing claude CLI's PS1? Reading `/proc/<pid>/cwd`? PTY OSC-7 sequence?). Without a defined mechanism, the table's value-add is null. Pin source-of-truth, then test it.

## P2 — User-initiated backup `VACUUM INTO` (§6) has no test

`Settings → Backup → Export` calls `VACUUM INTO`. No test in chapter 12 covers backup or restore. Add `db/backup-restore.spec.ts`.

## Summary

P0: 2 / P1: 4 / P2: 1
Most-severe: **Migration lockfile (the only enforcer of forbidden-pattern #4 "no migration edits post-ship") is mentioned but not specified or tested — forbidden-pattern enforcement is paper-only.**
