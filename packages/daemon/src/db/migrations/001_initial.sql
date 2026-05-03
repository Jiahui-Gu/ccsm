-- packages/daemon/src/db/migrations/001_initial.sql
--
-- FOREVER-STABLE per docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
-- chapter 07 §3 (SQLite schema, v0.3 baseline) + §4 (migration immutability).
--
-- This file is IMMUTABLE after v0.3 ships. Any change to a single byte after
-- the v0.3.0 tag breaks `tools/check-migration-locks.sh` (compares SHA256
-- against the v0.3.0 GitHub release body) AND the runtime self-check in
-- `packages/daemon/src/db/locked.ts` (Task #56 / T5.4). Forward-only: v0.4
-- ships `002_*.sql` etc., never edits this file.
--
-- PRAGMAs are NOT included here — they are applied by the better-sqlite3
-- wrapper (`packages/daemon/src/db/sqlite.ts`, T5.1 / Task #54) at boot time
-- AFTER opening the connection but BEFORE running migrations (ch07 §3).
-- Keeping PRAGMAs out of the migration file means a future settings change
-- (e.g. `Settings.sqlite_synchronous`) does not require a migration edit.
--
-- All ULID columns are `TEXT PRIMARY KEY` (lexicographically time-ordered,
-- 26 chars). All `_ms` columns are unix milliseconds (INTEGER).

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL  -- unix ms
);

-- principals: identity rows. v0.3 ships `kind = 'local-user'` only; v0.4
-- inserts `cf-access` rows additively. principalKey shape is `<kind>:<sub>`
-- e.g. `local-user:1000`.
CREATE TABLE principals (
  id            TEXT PRIMARY KEY,             -- principalKey, e.g. "local-user:1000"
  kind          TEXT NOT NULL,                -- "local-user" (v0.3)
  display_name  TEXT NOT NULL DEFAULT '',
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
);

-- sessions: one row per CreateSession RPC. `state` mirrors the SessionState
-- proto enum int. `should_be_running` drives daemon-restart restore loop
-- (chapter 05 §7): SELECT id FROM sessions WHERE should_be_running = 1
-- AND state IN (RUNNING, DEGRADED). CreateSession sets it to 1; explicit
-- DestroySession RPC sets it to 0; PTY crash (state=CRASHED) flips it to 0
-- (chapter 06 §1). v0.4 multi-principal respects the same column with no
-- schema change.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,           -- ULID
  owner_id        TEXT NOT NULL REFERENCES principals(id),
  state           INTEGER NOT NULL,           -- mirrors SessionState enum int
  cwd             TEXT NOT NULL,
  env_json        TEXT NOT NULL,              -- JSON object
  claude_args_json TEXT NOT NULL,             -- JSON array
  geometry_cols   INTEGER NOT NULL,
  geometry_rows   INTEGER NOT NULL,
  exit_code       INTEGER NOT NULL DEFAULT -1,-- -1 if not exited
  created_ms      INTEGER NOT NULL,
  last_active_ms  INTEGER NOT NULL,
  should_be_running INTEGER NOT NULL DEFAULT 1 -- 0 if user destroyed; 1 if daemon should respawn on boot
);
CREATE INDEX idx_sessions_owner_state ON sessions(owner_id, state);

-- pty_snapshot: one row per snapshot the pty-host emits (chapter 06 §2).
-- `payload` is SnapshotV1 bytes; `base_seq` is the delta seq the snapshot
-- was taken at. Pruning of older snapshots is the daemon's responsibility
-- (chapter 06 §4); the schema does not enforce retention.
CREATE TABLE pty_snapshot (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  base_seq   INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  geometry_cols INTEGER NOT NULL,
  geometry_rows INTEGER NOT NULL,
  payload    BLOB NOT NULL,                   -- SnapshotV1 bytes (chapter 06 §2)
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, base_seq)
);
CREATE INDEX idx_pty_snapshot_recent ON pty_snapshot(session_id, base_seq DESC);

-- pty_delta: per-session ordered raw VT byte segments (chapter 06 §3).
-- Pruning rule: rows with `seq < latest_snapshot.base_seq - DELTA_RETENTION_SEQS`
-- (=4096) are deleted by the daemon after each snapshot write (chapter 06 §4).
CREATE TABLE pty_delta (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  payload    BLOB NOT NULL,                   -- raw VT bytes (chapter 06 §3)
  ts_ms      INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- crash_log: every captured crash event (chapter 09 §1). `owner_id` is
-- principalKey for session-attributable crashes; sentinel `'daemon-self'`
-- for daemon-side crashes (chapter 09 §1). NOT NULL DEFAULT 'daemon-self'
-- means v0.4 multi-principal scoping lands as row-additive (new INSERTs
-- carry attributable principalKeys), not column-additive.
CREATE TABLE crash_log (
  id        TEXT PRIMARY KEY,                 -- ULID
  ts_ms     INTEGER NOT NULL,
  source    TEXT NOT NULL,                    -- chapter 04 §5 / chapter 09 §1 open string set
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  owner_id  TEXT NOT NULL DEFAULT 'daemon-self' -- principalKey or 'daemon-self' sentinel
);
CREATE INDEX idx_crash_log_recent ON crash_log(ts_ms DESC);
CREATE INDEX idx_crash_log_owner_recent ON crash_log(owner_id, ts_ms DESC);

-- settings: composite PK from day one so v0.4 per-principal overrides land
-- as new rows with `scope = 'principal:<principalKey>'`, NOT as a column add
-- or a new table. v0.3 daemon writes `scope = 'global'` for every row and
-- rejects any other scope at the RPC layer (chapter 04 §6, chapter 05 §5).
-- `value` is JSON-encoded; readers parse per key.
CREATE TABLE settings (
  scope TEXT NOT NULL,                         -- 'global' in v0.3; 'principal:<principalKey>' in v0.4+
  key   TEXT NOT NULL,
  value TEXT NOT NULL,                         -- JSON-encoded; readers parse per key
  PRIMARY KEY (scope, key)
);

-- principal_aliases: empty in v0.3; populated in v0.4 to thread local-user
-- continuity across identity sources (e.g., local-user uid → cf-access sub).
-- Keyed by alias so a single canonical principal can absorb many aliases
-- over time. v0.3 daemon ignores this table.
CREATE TABLE principal_aliases (
  alias_principal_key     TEXT NOT NULL PRIMARY KEY,
  canonical_principal_key TEXT NOT NULL,
  created_ms              INTEGER NOT NULL
);

-- cwd_state: per-session "last known cwd" tracker. Update path: pty-host
-- child parses OSC 7 (`ESC ] 7 ; file://<host>/<path> BEL`) from the raw VT
-- byte stream as the SOLE source of truth for cwd updates (T5.8 / Task #59).
-- Daemon UPSERTs through the write coalescer (chapter 07 §5). Restored
-- sessions read this row at boot; if absent (no OSC 7 ever observed), they
-- fall back to sessions.cwd. The daemon does NOT shell out to lsof/proc.
CREATE TABLE cwd_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  cwd        TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
