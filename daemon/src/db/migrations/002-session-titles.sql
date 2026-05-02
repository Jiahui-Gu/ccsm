-- 002-session-titles: SDK-derived session title cache.
--
-- Backs session_titles.proto:
--   * GetSessionTitle / RenameSessionTitle  (per-session lookup)
--   * ListSessionTitlesForProject           (project_path → entries)
--
-- v0.2 stored these only in `~/.claude/projects/<key>/<sid>.jsonl`
-- (CLI-owned, untouched by ccsm). v0.3 adds an in-daemon mirror so the
-- desktop client can list project sessions WITHOUT the SDK round-trip
-- (fixes "session list flicker on every focus" called out in
-- v0.3-design.md). Mirror is best-effort; SDK is still source of truth.
--
-- session_id is logically a foreign key to sessions(id) but we DO NOT
-- declare REFERENCES — the SDK can write a title for a session that the
-- daemon hasn't yet seen (claude CLI ran in another window, ccsm starts
-- after the JSONL was created). The session row gets backfilled lazily.
--
-- Additive: brand-new table. No drop / no rename / no NOT-NULL-without-default
-- on existing rows.

CREATE TABLE IF NOT EXISTS session_titles (
  session_id    TEXT PRIMARY KEY,
  project_path  TEXT,
  title         TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_session_titles_project
  ON session_titles (project_path, updated_at_ms DESC);
