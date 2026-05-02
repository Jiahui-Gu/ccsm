# 07 — Data and State

The daemon owns all state. Electron is stateless across launches (modulo trivial UI prefs in `localStorage`; not authoritative). This chapter pins the SQLite schema, the per-OS state directory layout, the migration story, the WAL/checkpoint discipline, and the backup/recovery posture.

### 1. Storage choice: SQLite via `better-sqlite3`

Single-file SQLite database, `better-sqlite3` driver, WAL mode, `synchronous = NORMAL`, `foreign_keys = ON`. Synchronous (NOT async) driver because:
- The daemon serializes writes through the main thread's coalescer (pty-host workers `postMessage` deltas; main thread batches writes).
- Synchronous calls eliminate a class of write-ordering bugs that async drivers introduce (interleaved transactions across event-loop ticks).
- `better-sqlite3` is a native module that bundles cleanly into Node 22 sea (see [10](./10-build-package-installer.md) — flagged MUST-SPIKE).

> **MUST-SPIKE [better-sqlite3-in-sea]**: hypothesis: `better-sqlite3` (a `.node` binary) can be embedded in a Node 22 sea blob and loaded at runtime. · validation: build sea on each OS, run `new Database(":memory:")` smoke. · fallback: ship `better-sqlite3.node` alongside the sea executable and `require()` it via an absolute path resolved relative to the executable.

### 2. State directory layout (per OS)

<!-- F2: closes R0 03-P0.3 / R2 P0-02-3 — descriptor path is locked unconditionally per OS; no per-install variation. -->

| OS | Daemon state root | DB path | Crash log file (raw) | Listener descriptor |
| --- | --- | --- | --- | --- |
| Windows | `%PROGRAMDATA%\ccsm\` | `state\ccsm.db` | `state\crash-raw.ndjson` | `%PROGRAMDATA%\ccsm\listener-a.json` (LOCKED unconditionally; NEVER `%LOCALAPPDATA%`, NEVER `%APPDATA%`; DACL `BUILTIN\Users:Read` + `BUILTIN\Administrators:FullControl` + `LocalService:Modify` per [03](./03-listeners-and-transport.md) §3) |
| macOS | `/Library/Application Support/ccsm/` | `state/ccsm.db` | `state/crash-raw.ndjson` | `/Library/Application Support/ccsm/listener-a.json` (system-wide; NEVER `~/Library/...`; mode `0644` owner `_ccsm:_ccsm`) |
| Linux | `/var/lib/ccsm/` | `state/ccsm.db` | `state/crash-raw.ndjson` | `/var/lib/ccsm/listener-a.json` (durable state dir, NOT `/run/ccsm/`; mode `0644` owner `ccsm:ccsm` for FHS group-readability) |

All paths created with mode `0700` for the daemon's service account EXCEPT the descriptor file which is mode `0644` (group-readable so per-user Electron can read it without joining the daemon's service-account group). Directory ownership and ACL set by the installer (see [10](./10-build-package-installer.md) §5).

#### 2.1 Descriptor file lifecycle (locked, no installer or shutdown-hook GC required)

<!-- F2: closes R2 P0-02-3 / R2 P0-03-4 — atomic write; per-boot rewrite; no within-boot churn; orphan files between boots are normal and handled by boot_id mismatch. -->

- Daemon writes the descriptor exactly **once per daemon boot**, atomically (write `listener-a.json.tmp` → `fsync` → `rename`), at startup ordering step 5 (chapter [02](./02-process-topology.md) §3) BEFORE Supervisor `/healthz` flips to 200. The descriptor carries `boot_id` (random UUIDv4 per boot, regenerated on every daemon process start), `daemon_pid`, `listener_addr`, `protocol_version`, plus the §3.2 fields in [03](./03-listeners-and-transport.md).
- Daemon does NOT re-write the descriptor within a single boot. Listener A reconnect inside the same daemon process keeps the same `boot_id` and address; nothing on disk changes.
- On daemon clean shutdown the file is **left in place**. Orphan files between daemon boots are normal — Electron's `boot_id` mismatch check (chapter [03](./03-listeners-and-transport.md) §3.3) catches stale files on the next connect attempt and triggers a re-read with backoff. There is no installer / shutdown-hook GC step required for descriptor files.
- On daemon start, the daemon ALWAYS rewrites the file (does not trust prior contents) — the new `boot_id` is the freshness witness; even if the address is identical the file is rewritten so a stale `daemon_pid` doesn't linger.
- On daemon hard crash (no graceful unlink): the OS leaves the file in place; the next daemon boot rewrites it; any Electron that connected between crash and rewrite hits the `boot_id` mismatch path and retries.

XDG: on Linux, the daemon runs as a system service (not `--user`), so `XDG_*` user vars do not apply; `/var/lib/ccsm/` is the FHS-correct path. **Do not respect `XDG_DATA_HOME` for daemon state** — the daemon may run with no logged-in user.

Electron-side state (per-user, ephemeral): `%APPDATA%\ccsm-electron\` (win), `~/Library/Application Support/ccsm-electron/` (mac), `${XDG_CONFIG_HOME:-~/.config}/ccsm-electron/` (linux). Contains: window geometry, last-applied-seq cache for fast reconnect, theme. **NOT** authoritative; deletable any time.

### 3. SQLite schema (v0.3 baseline)

All tables created by the migration `001_initial.sql`. ULIDs as `TEXT PRIMARY KEY` (lexicographically time-ordered, 26 chars).

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL  -- unix ms
);

CREATE TABLE principals (
  id            TEXT PRIMARY KEY,             -- principalKey, e.g. "local-user:1000"
  kind          TEXT NOT NULL,                -- "local-user" (v0.3)
  display_name  TEXT NOT NULL DEFAULT '',
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
);

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

CREATE TABLE pty_delta (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  payload    BLOB NOT NULL,                   -- raw VT bytes (chapter 06 §3)
  ts_ms      INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
-- pruning: see chapter 06 §4

<!-- F1: closes R0 07-P0.1 / R0 07-P0.2 / R0 07-P0.3 / R0 09-P0.1 — owner_id, scoped settings, and principal_aliases land in 001_initial.sql so v0.4 multi-principal scoping is row-additive, not column-additive. -->

CREATE TABLE crash_log (
  id        TEXT PRIMARY KEY,                 -- ULID
  ts_ms     INTEGER NOT NULL,
  source    TEXT NOT NULL,                    -- chapter 04 §5 / chapter 09 §1 open string set
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  owner_id  TEXT NOT NULL DEFAULT 'daemon-self' -- principalKey for session-attributable crashes; sentinel 'daemon-self' otherwise (see chapter 09 §1)
);
CREATE INDEX idx_crash_log_recent ON crash_log(ts_ms DESC);
CREATE INDEX idx_crash_log_owner_recent ON crash_log(owner_id, ts_ms DESC);

CREATE TABLE settings (
  -- Composite PK from day one so v0.4 per-principal overrides land as new
  -- rows with scope='principal:<principalKey>', not as a column add or a
  -- new table. v0.3 daemon writes scope='global' for every row and rejects
  -- any other scope at the RPC layer (see chapter 04 §6 and chapter 05 §5).
  scope TEXT NOT NULL,                         -- 'global' in v0.3; 'principal:<principalKey>' in v0.4+
  key   TEXT NOT NULL,
  value TEXT NOT NULL,                         -- JSON-encoded; readers parse per key
  PRIMARY KEY (scope, key)
);

CREATE TABLE principal_aliases (
  -- Empty in v0.3; populated in v0.4 to thread local-user continuity
  -- across identity sources (e.g., a user's local-user uid → their
  -- cf-access sub). Keyed by alias so a single canonical principal can
  -- absorb many aliases over time. v0.3 daemon ignores this table.
  alias_principal_key     TEXT NOT NULL PRIMARY KEY,
  canonical_principal_key TEXT NOT NULL,
  created_ms              INTEGER NOT NULL
);

CREATE TABLE cwd_state (
  -- Per-session "last known cwd" tracker so a session restored after crash
  -- restarts in the cwd the user was actually in, not the original CreateSession cwd.
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  cwd        TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
```

### 4. Migration story

- One file per migration: `packages/daemon/src/db/migrations/NNN_<name>.sql`. v0.3 ships exactly `001_initial.sql`.
- On daemon boot: read `schema_migrations.version`, run any unapplied files in order in a transaction, insert the row, commit.
- **Migrations are forward-only**. No `down`. If a migration is wrong, the next migration fixes it forward.
- **v0.3 migration files are immutable after v0.3 ships.** v0.4 starts at `002_*.sql`. Editing `001_initial.sql` post-ship is a hard CI block (`buf breaking`-style: a SHA256 of `001_initial.sql` is committed as a constant in `packages/daemon/src/db/migrations/locked.ts`; CI compares).

### 5. Write coalescing

- pty-host workers `postMessage({ kind: "delta", sessionId, seq, payload, tsMs })` to main thread.
- Main thread enqueues into a `BetterQueue` keyed by session.
- A 16 ms tick flushes per-session delta batches as one `INSERT INTO pty_delta` prepared statement repeated inside one `IMMEDIATE` transaction.
- Snapshot writes are out-of-band: own transaction, runs during a quiescent moment (no current delta flush in progress for that session); blocks deltas for that session for the snapshot duration.
- WAL checkpoint: `PRAGMA wal_autocheckpoint = 1000`; full `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown only.

### 6. Backup and recovery

v0.3 has **no automated backup**. Recovery posture:

- WAL mode + `synchronous = NORMAL` survives process kill with at most the most recent uncommitted transaction lost.
- Full power loss may corrupt the DB in extremely rare cases; daemon on boot runs `PRAGMA integrity_check`. On failure: rename `ccsm.db` → `ccsm.db.corrupt-<ts>`, start fresh with `001_initial.sql`, write a `crash_log` entry (best-effort, may also fail), surface in Settings UI on next Electron connect.
- User-initiated backup: `Settings → Backup → Export` runs `VACUUM INTO '<path>'`; UX in [12](./12-testing-strategy.md) §4 has the test for this.
- Restore: `Settings → Restore` stops sessions, swaps the file, reboots the daemon. v0.3 only. Risky; gated behind a confirmation dialog naming each session that will be terminated.

### 7. v0.4 delta

- **Add** new migration files `002_*.sql`, `003_*.sql`, ... (additive only):
  - `crash_log.uploaded_at INTEGER` column for upload tracking (NULL = never uploaded).
  - `tunnel_state` table for cloudflared sidecar config.
  - new `principals.kind` value `cf-access`.
- **Use** existing `crash_log.owner_id` column (already `NOT NULL` from v0.3 with `'daemon-self'` sentinel) — v0.4 starts populating it with attributable principalKeys for cf-access principals; no schema change.
- **Use** existing `settings(scope, key, value)` shape — v0.4 inserts new rows with `scope = 'principal:<principalKey>'`; existing `scope = 'global'` rows remain valid as defaults.
- **Populate** existing `principal_aliases` table — v0.4 inserts mapping rows to thread `local-user` uid continuity into cf-access `sub` values; v0.3 daemon ignores the table.
- **Add** optional automated daily backup (writes `VACUUM INTO` to a rolling location); v0.3 manual backup remains.
- **Unchanged**: every column listed in §3, every table definition, the pty wire payloads, the migration discipline, the per-OS state root, the `crash_log.owner_id` column shape, the `settings (scope, key, value)` shape, the `principal_aliases` table shape.
