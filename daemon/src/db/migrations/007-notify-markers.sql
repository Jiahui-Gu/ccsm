-- 007-notify-markers: user-input markers + visual flash sink.
--
-- Backs notify.proto §NotifyUserInput / §StreamNotifyFlash. The marker
-- row is the daemon-side audit trail of "the user typed something into
-- this session" — used to:
--   * dedupe duplicate NotifyUserInput RPCs by `idempotency_key`
--     (ch02 §9 lock; same retry-replay contract as 003 / 004),
--   * drive the flash event broadcast on StreamNotifyFlash without
--     keeping per-subscriber state in memory,
--   * post-mortem "did the user press enter before the crash" when
--     correlating with crash dumps (frag-6-7 §6.6.3).
--
-- session_id NOT declared as a FK — markers may outlive the session row
-- (audit trail), and accepting a marker for a yet-unseen session_id is
-- valid (claude CLI may write JSONL faster than ccsm sees the spawn).
--
-- Additive: brand-new table.

CREATE TABLE IF NOT EXISTS notify_markers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  ts_ms           INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_notify_markers_session_ts
  ON notify_markers (session_id, ts_ms DESC);
