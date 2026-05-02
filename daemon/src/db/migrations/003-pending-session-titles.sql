-- 003-pending-session-titles: durable queue for SDK title-derivation jobs.
--
-- Backs session_titles.proto §EnqueuePendingSessionTitle +
-- §FlushPendingSessionTitles. v0.2 derived titles inline on every
-- assistant message (electron/sessionTitles/derive.ts), which blocked
-- the renderer for several hundred ms on long messages. v0.3 enqueues
-- here; a daemon background worker drains the queue and updates
-- `session_titles` (table 002).
--
-- idempotency_key is the de-dup primary key so the same enqueue request
-- replayed (Connect retry, Electron crash mid-write) produces exactly one
-- queue row. Pairs with ch02 §9 idempotency contract.
--
-- session_id NOT a FK: same rationale as 002 (title may arrive before the
-- session row backfills).
--
-- Additive: brand-new table.

CREATE TABLE IF NOT EXISTS pending_session_titles (
  idempotency_key TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  raw_message     TEXT NOT NULL,
  enqueued_at_ms  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

-- Drain order: oldest first per session, so old titles do not overwrite
-- newer ones if the worker batches.
CREATE INDEX IF NOT EXISTS idx_pending_session_titles_session_enqueued
  ON pending_session_titles (session_id, enqueued_at_ms);
