-- 001-session-extensions: additive columns on `sessions` for the v0.3
-- backend-authoritative session model (final-arch §2.7, sessions.proto
-- §SessionInfo / §SessionSnapshot, frag-3.5.1 §3.5.1.4 PTY resume).
--
-- Why missing from v0.3.sql: the canonical schema (T28) only carried the
-- v0.2 → v0.3 path-move columns. The Connect data plane (PR #102 proto
-- extension) added SessionInfo/SessionSnapshot which require cwd,
-- spawn_cwd, latest_seq, boot_nonce on the session row. Lift to a
-- migration so the schema-additive lint owns the additive contract from
-- here forward (.v03-baseline = __none__).
--
-- Idempotent: every column add is wrapped via the runner's
-- "ADD COLUMN IF NOT EXISTS" sniff (better-sqlite3 has no native
-- IF NOT EXISTS for ADD COLUMN — runner does the table_info check).
-- Treat each statement as additive: nullable, no DEFAULT-NOT-NULL,
-- no destructive DDL.
--
-- Rationale per column:
--   cwd           — effective cwd after any SessionCwdRedirected events
--                   (sessions.proto §SessionInfo line "cwd = 3").
--   spawn_cwd     — original cwd at spawn time (SessionSnapshot line 6
--                   "Original cwd at spawn time (for `redirected from`
--                   diagnostics)").
--   latest_seq    — daemon-assigned monotonic seq of the latest mutation
--                   (SessionInfo line 7); clients diff against last-seen.
--   boot_nonce    — daemon ULID stamped on session-creation; mismatch ⇒
--                   client snapshot-replay (frag-3.5.1 §3.5.1.4).
--   spawned_at_ms — ms-epoch at spawn (SessionInfo line 5). Distinct
--                   from created_at which v0.3.sql already has but
--                   served the row-create timestamp not the PTY-spawn.
--   requires_action_at_ms — when state transitioned to requires_action
--                   (notify badging in renderer; common.proto SessionState).
--
-- All columns NULL-tolerant: existing rows pre-migration get NULL,
-- runner code reads NULL as "unset / use default".

ALTER TABLE sessions ADD COLUMN cwd TEXT;
ALTER TABLE sessions ADD COLUMN spawn_cwd TEXT;
ALTER TABLE sessions ADD COLUMN latest_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN boot_nonce TEXT;
ALTER TABLE sessions ADD COLUMN spawned_at_ms INTEGER;
ALTER TABLE sessions ADD COLUMN requires_action_at_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_sessions_latest_seq
  ON sessions (latest_seq);
