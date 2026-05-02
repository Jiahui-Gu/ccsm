-- 004-recent-cwds: per-machine recent-cwd LRU.
--
-- Backs core.proto §PushUserCwd / import.proto §GetRecentCwds. v0.2
-- stored a fixed-size JSON array in `app_state.user_cwds`. v0.3 promotes
-- to a dedicated table so we can:
--   * dedupe by 60 s window using `idempotency_key` (ch02 §9 lock),
--   * rank by recency without rewriting the whole JSON blob on every
--     push,
--   * answer GetRecentCwds(limit=N) with a single indexed query.
--
-- `cwd` is the natural primary key — duplicate pushes are LWW updates
-- of `last_used_at_ms` + `use_count + 1`, NOT new rows. This also makes
-- the LRU prune trivial (DELETE FROM recent_cwds WHERE last_used_at_ms
-- < ?). The `app_state.user_cwds` JSON column stays put for backwards-
-- read by any v0.3 build that hasn't yet cut over to this table —
-- additive promise: do not drop, dual-read until v0.4.
--
-- Additive: brand-new table.

CREATE TABLE IF NOT EXISTS recent_cwds (
  cwd              TEXT PRIMARY KEY,
  last_used_at_ms  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  use_count        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_recent_cwds_last_used
  ON recent_cwds (last_used_at_ms DESC);
