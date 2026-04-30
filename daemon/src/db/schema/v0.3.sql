-- ccsm v0.3 canonical SQLite schema. Single source of truth consumed by:
--   * T29 migration runner (applies this at end of v0.2 -> v0.3 migration)
--   * T36 fresh-install boot path (applies this directly on a brand-new dataRoot)
-- Spec refs: docs/superpowers/specs/v0.3-design.md §11 (release/packaging),
--            v0.3-fragments/frag-8-sqlite-migration.md (data migration),
--            v0.3-fragments/frag-6-7-reliability-security.md §6.8
--            (close_to_tray_shown_at column lock, R3-T12).

-- WAL required for daemon concurrent writers (PTY ingest + RPC handlers
-- + supervisor + jobs runner all write into the same db).
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  v TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  repo          TEXT,
  title         TEXT,
  state         TEXT NOT NULL,
  pid           INTEGER,
  pgid          INTEGER,
  -- ULID allocated per pty.spawn() so daemon-originated PTY events
  -- (ptyExit, subscriber-dropped-slow, pty.spawn.failed) correlate to
  -- the spawn line without an upstream RPC traceId. v0.3-design.md
  -- §3.5.1.2 (line 477) + §6.6.1.
  spawn_trace_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  trace_id    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  config      TEXT NOT NULL,           -- JSON blob, daemon-opaque
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,         -- JSON blob, daemon-opaque
  status        TEXT NOT NULL,
  scheduled_at  INTEGER NOT NULL,
  run_at        INTEGER,
  completed_at  INTEGER
);

-- Singleton typed prefs row. v0.2 stored these as KV strings in
-- app_state(key,value); v0.3 promotes the documented keys to typed
-- columns so the daemon can read them without per-key JSON parsing.
-- T29 migration runner converts the KV rows. close_to_tray_shown_at
-- is the timestamp lock from frag-6-7 §6.8 (R3-T12) — supersedes the
-- earlier boolean close_to_tray_hint_shown that frag-3.7 had proposed.
CREATE TABLE IF NOT EXISTS app_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  close_to_tray_shown_at   INTEGER,
  close_action             TEXT,
  notify_enabled           INTEGER,
  crash_reporting_opt_out  INTEGER,
  user_cwds                TEXT,        -- JSON array
  updated_at               INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_state (id, updated_at) VALUES (1, 0);

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages (session_id, created_at);

-- Job queue scan: "next due job in pending status". Composite index lets
-- the runner hit (status='pending', scheduled_at <= now()) with a single
-- range scan instead of a full table scan as the queue grows.
CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled
  ON jobs (status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_sessions_state
  ON sessions (state);

INSERT OR REPLACE INTO schema_version (v) VALUES ('0.3');
