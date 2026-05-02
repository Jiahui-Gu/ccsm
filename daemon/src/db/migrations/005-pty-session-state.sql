-- 005-pty-session-state: per-PTY snapshot+seq cursor for resume.
--
-- Backs pty.proto §StreamPtyData (`from_seq` + `from_boot_nonce`
-- contract; frag-3.5.1 §3.5.1.4 canonical owner) and the headless
-- xterm buffer snapshot referenced in
-- docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md Task 11
-- ("xterm-headless buffer per session" + "seq counter").
--
-- Daemon-only state. Persisted (not just in-memory) so a clean shutdown
-- can resume a long-running PTY without forcing the renderer to replay
-- from seq 0. Survives the daemon process; reset to seq=0 on
-- boot_nonce change.
--
-- session_id REFERENCES sessions(id) ON DELETE CASCADE so killing a
-- session cleans up its cursor row.
--
-- last_snapshot is the serialized xterm-headless buffer (compressed by
-- caller); BLOB so we don't pay JSON tax on the hot path. Cap is
-- enforced at write time, not in DDL.
--
-- Additive: brand-new table.

CREATE TABLE IF NOT EXISTS pty_session_state (
  session_id           TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  latest_seq           INTEGER NOT NULL DEFAULT 0,
  boot_nonce           TEXT,
  last_snapshot        BLOB,
  last_snapshot_at_ms  INTEGER,
  updated_at_ms        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_pty_session_state_updated
  ON pty_session_state (updated_at_ms DESC);
