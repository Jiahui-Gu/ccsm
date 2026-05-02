# 07 — Data and State

The daemon owns all state. Electron is stateless across launches (modulo trivial UI prefs in `localStorage`; not authoritative). This chapter pins the SQLite schema, the per-OS state directory layout, the migration story, the WAL/checkpoint discipline, and the backup/recovery posture.

### 1. Storage choice: SQLite via `better-sqlite3`

Single-file SQLite database, `better-sqlite3` driver, WAL mode, `synchronous = NORMAL` **default** (configurable per §3 below via `Settings.sqlite_synchronous`), `foreign_keys = ON`. Synchronous (NOT async) driver because:
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

<!-- F5: closes R0 07-P1.1 — systemd RuntimeDirectory directives are locked here so the installer template (chapter 10 §5) and the daemon's bind logic (chapter 02 §3) reference one canonical source. -->

**Linux systemd directives (locked)** — the `ccsm-daemon.service` unit MUST include the following directives so systemd creates and tears down the runtime directory with correct ownership/mode automatically. The daemon does NOT create `/run/ccsm/` itself; it relies on systemd:

```ini
[Service]
RuntimeDirectory=ccsm
RuntimeDirectoryMode=0750
StateDirectory=ccsm
StateDirectoryMode=0750
User=ccsm
Group=ccsm
```

`RuntimeDirectory=ccsm` causes systemd to create `/run/ccsm/` owned by `ccsm:ccsm` mode `0750` on service start and remove it on stop. `/run/ccsm/` is where the daemon binds the Listener-A UDS (chapter [03](./03-listeners-and-transport.md) §3) — the descriptor file `listener-a.json` lives in `/var/lib/ccsm/` (the StateDirectory) per §2 above, NOT in `/run/ccsm/`, because the descriptor must persist across daemon restarts to drive Electron's `boot_id` mismatch retry path. `0750` (group-readable) lets the per-user Electron's group membership in `ccsm` (set by the installer) `connect()` the UDS without needing world-write.

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
-- synchronous is configurable per Settings.sqlite_synchronous (see below); daemon applies the
-- chosen value at boot AFTER opening the connection but BEFORE running migrations.
-- Default: NORMAL. Allowed values: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA'. Default 'NORMAL' is the
-- ship value for v0.3 dogfood; users on flaky storage MAY raise to 'FULL' via Settings.
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_size_limit = 67108864;  -- 64 MiB cap on -wal file growth (see §5 WAL discipline)

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
  -- should_be_running semantics (R5 P0-07-1, F5): chapter 05 §7 daemon-restart restore loop reads
  -- `SELECT id FROM sessions WHERE should_be_running = 1 AND state IN (RUNNING, DEGRADED)`
  -- to decide which sessions to respawn after daemon boot. CreateSession sets it to 1; explicit
  -- DestroySession RPC sets it to 0; PTY crash (state=CRASHED) flips it to 0 (chapter 06 §1) so
  -- the daemon does NOT auto-recreate a crashed pty-host on next boot. v0.4 multi-principal
  -- daemon respects the same column with no schema change.
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
  -- Update path (R4 P1 ch 07, F5): the pty-host child parses OSC 7 sequences
  -- (xterm/iTerm2 "current working directory" notification: ESC ] 7 ; file://<host>/<path> BEL)
  -- from the raw VT byte stream as the SOLE source of truth for cwd updates. The shell
  -- (claude's spawned shell, via PROMPT_COMMAND/precmd hooks) is responsible for emitting
  -- OSC 7 on every cd; the daemon does NOT shell out to lsof/proc to discover cwd. On parse,
  -- the pty-host child posts {kind: "cwd_update", sessionId, cwd, tsMs} to the daemon main
  -- process which UPSERTs this row through the write coalescer (§5). Restored sessions read
  -- this row at boot; if absent (no OSC 7 ever observed), they fall back to sessions.cwd.
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  cwd        TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
```

<!-- F5: closes R0 07-P1.2 — SQLite synchronous configurability moved to Settings so users on flaky storage can opt into FULL without a daemon code change or schema migration. -->

**Settings keys consumed by the storage layer** (FOREVER-STABLE in v0.3; live in the `settings` table with `scope = 'global'`):

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `sqlite_synchronous` | string enum | `"NORMAL"` | Applied as `PRAGMA synchronous = <value>` at boot AFTER opening the connection. Allowed: `"OFF"`, `"NORMAL"`, `"FULL"`, `"EXTRA"`. Daemon rejects any other value at the `UpdateSettings` RPC layer (chapter [04](./04-proto-and-rpc-surface.md) §6) with `INVALID_ARGUMENT`. Change requires daemon restart to take effect (the value is read once at boot). |
| `wal_autocheckpoint_pages` | integer | `1000` | Applied as `PRAGMA wal_autocheckpoint = <value>` at boot. Range 100–100000. |
| `pty_snapshot_compression_codec` | integer | `1` | `1 = zstd`, `2 = gzip` (chapter [06](./06-pty-snapshot-delta.md) §2). |

### 4. Migration story

- One file per migration: `packages/daemon/src/db/migrations/NNN_<name>.sql`. v0.3 ships exactly `001_initial.sql`.
- On daemon boot: read `schema_migrations.version`, run any unapplied files in order in a transaction, insert the row, commit.
- **Migrations are forward-only**. No `down`. If a migration is wrong, the next migration fixes it forward.
- **v0.3 migration files are immutable after v0.3 ships.** v0.4 starts at `002_*.sql`. Editing `001_initial.sql` post-ship is a hard CI block (`buf breaking`-style: a SHA256 of `001_initial.sql` is committed as a constant in `packages/daemon/src/db/migrations/locked.ts`; CI compares).

<!-- F5: closes R0 07-P1.3 + R4 P0 ch 07 migration immutability SHA256 lock — the lock is enforced by a CI script that compares the in-tree SHA against the SHA recorded at the v0.3 release tag, so any post-tag edit fails CI. -->

**Migration SHA256 lock (CI-enforced, FOREVER-STABLE)** — the immutability invariant is mechanically enforced:

1. At v0.3 tag time, CI computes `sha256sum packages/daemon/src/db/migrations/001_initial.sql` and writes the digest into the GitHub release body under the heading `### Migration locks` (one line per migration). The release notes for v0.3.0 are the canonical source.
2. The script `tools/check-migration-locks.sh` (run in CI on every PR after the v0.3 tag exists) does:
   - `gh release view v0.3.0 --json body --jq .body` to fetch release notes from the v0.3 release tag (NOT from `main` branch — the release tag is the immutable witness).
   - Parses the `### Migration locks` block to extract `(filename → sha256)` pairs.
   - For each pair, computes the local SHA of the file at HEAD and compares.
   - Exits non-zero on any mismatch OR on any v0.3-vintage file (`001_*.sql`) that has been deleted.
   - Pre-tag (no v0.3 release exists yet), the script no-ops — it's only meaningful AFTER the freeze.
3. The script also enforces that `packages/daemon/src/db/migrations/locked.ts` exports a `MIGRATION_LOCKS` const matching the release-tag SHAs; a developer who edits `001_initial.sql` and updates `locked.ts` to match will still fail CI because the script compares against the GitHub release body, not against `locked.ts`. `locked.ts` is the runtime self-check (daemon at boot computes SHAs of bundled migrations and asserts against `MIGRATION_LOCKS`); the GitHub release body is the source-of-truth that CI cross-checks.
4. v0.4 adds `002_*.sql` etc.; CI extends the release-notes block with new entries at v0.4 tag time. The v0.3 entries remain forever — any deletion/edit of v0.3 files breaks CI on every subsequent PR.

### 4.5 v0.2 → v0.3 user-data migration (one-shot, installer-driven)

<!-- F6: closes R1 P1.1 (chapter 08) — v0.2 user data migration narrative. F5 owns the §3 schema and §4 migration story; F6 owns this §4.5 migration narrative. -->

The daemon split moves authoritative state from per-user Electron paths (`%APPDATA%\ccsm\` win, `~/Library/Application Support/ccsm/` mac, `${XDG_CONFIG_HOME:-~/.config}/ccsm/` linux) to the system-service paths in §2 above. v0.2 users upgrading to v0.3 would otherwise see a fully-empty app (no sessions, no settings, no crash log). v0.3 ships a one-shot **hybrid migration**:

**What migrates** (best-effort; failure does not block first-launch):

1. **Sessions** — v0.2's session metadata (sessions table in v0.2's per-user `ccsm.db`) is copied into the daemon's v0.3 `sessions` table. Owner is set to the migrating OS user's `principalKey` (`local-user:<uid>`). Sessions whose `claude` CLI process is no longer running land in `state = EXITED`; sessions still attached to a live PTY are NOT migrated (v0.3 does not inherit live PTY state from a terminated v0.2 instance — out of scope, and the v0.2 process must be quit before v0.3 install per chapter [10](./10-build-package-installer.md) §6 update flow).
2. **Crash log** — v0.2's `crash_log`-equivalent rows (if any; v0.2 had Sentry only and no local crash table) are not migrated. v0.3 starts with an empty crash log; v0.2 crash history lives only in Sentry.

**What is dropped with first-launch banner** (UI prefs):

- `theme`, `fontSize`, `fontSizePx`, sidebar width, drafts, recent CWDs LRU, closeAction, notifyEnabled, crashReporting opt-out, last-used model, auto-update preference, sessionTitles backfill state, and other v0.2 `app_state` keys.
- These keys could in principle migrate into `Settings.ui_prefs` (chapter [04](./04-proto-and-rpc-surface.md) §6), but v0.2's keys are renderer-private and the v0.3 renderer's expected key shape may differ. Rather than ship a brittle key-rewriter, v0.3 drops these and surfaces a one-time **first-launch banner**:

  > **Welcome back to ccsm v0.3.** Your sessions have been migrated. UI preferences (theme, font, drafts, etc.) reset to defaults — please reconfigure under Settings. [Dismiss] [Open Settings]

  The banner reads/writes `Settings.ui_prefs["migration.v02_to_v03_banner_dismissed"] = "true"` to suppress on subsequent launches.

**Mechanism (installer-driven, NOT runtime-detected)**:

1. The v0.3 installer (chapter [10](./10-build-package-installer.md) §5) checks for the presence of a v0.2 user-data directory at the per-OS path enumerated above for the installing OS user.
2. If found, the installer copies (does NOT move — v0.2 directory is preserved for rollback) v0.2's `ccsm.db` to a staging location under the daemon's state root (`<state>/migration-staging/v02-<uid>.db`).
3. On first daemon boot post-install, the daemon detects staging files, runs a one-shot migrator that opens the staged DB, reads the sessions table, INSERTs into the v0.3 `sessions` table, and renames the staging file to `<state>/migration-staging/v02-<uid>.db.imported-<ts>`.
4. The daemon writes a `migration` capture-source crash_log entry on success (severity `info` — extends the §1 source set with a positive-outcome row; honored as additive per chapter [09](./09-crash-collector.md) §1 open-set rule) so the user sees an audit trail in Settings → Crash Reporting.
5. On migration failure (corrupt staged DB, schema-mismatch, etc.), the daemon emits a `migration` source crash_log entry with severity `warn` and the user lands at v0.3 with an empty session list. The first-launch banner is upgraded to mention the failure ("Sessions could not be migrated; see Crash Reporting for details").
6. v0.2 user-data directory is NEVER deleted by v0.3 — uninstalling v0.3 leaves v0.2 data intact. The user manually removes v0.2's `%APPDATA%\ccsm\` once they're confident in v0.3.

**v0.4 implication**: the migrator is one-shot and DELETED after v0.4 ships — by then v0.2 → v0.3 jumps are rare enough that maintenance cost outweighs benefit. v0.4 may add v0.3 → v0.4 migration if needed (additive new file under the same `migration-staging/` mechanism).

### 5. Write coalescing

- pty-host workers `postMessage({ kind: "delta", sessionId, seq, payload, tsMs })` to main thread.
- Main thread enqueues into a `BetterQueue` keyed by session.
- A 16 ms tick flushes per-session delta batches as one `INSERT INTO pty_delta` prepared statement repeated inside one `IMMEDIATE` transaction.
- Snapshot writes are out-of-band: own transaction, runs during a quiescent moment (no current delta flush in progress for that session); blocks deltas for that session for the snapshot duration.
- WAL checkpoint: `PRAGMA wal_autocheckpoint = 1000` (overridable per Settings); full `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown only.

<!-- F5: closes R3 P1-07-03 (escalated) + R4 P1 ch 07 write coalescer backpressure + WAL discipline. -->

**Failure handling (FOREVER-STABLE)** — every write through the coalescer is wrapped in `try { txn() } catch (err) { ... }`:

- On `SQLITE_FULL` / `SQLITE_IOERR` / `SQLITE_READONLY` / any disk-class error: the failed batch's bytes are dropped (NOT retried — retrying a full disk just spins). The daemon writes a `crash_log` row (`source = "sqlite_write_failure"`, `summary` includes the error code, the table name, and the session_id if applicable). The daemon process does NOT crash.
- A per-session `consecutiveDbWriteFailures` counter increments. On reaching `3`, the session transitions to `DEGRADED` (the same enum value as chapter [06](./06-pty-snapshot-delta.md) §4): live deltas continue to stream to subscribers from the in-memory ring (chapter 06 §4 N=4096), but no new rows are written until the cool-down period (60 s) expires and a probe write succeeds. This makes the daemon **survive disk-full** rather than die.
- Snapshot write failures follow the identical path (chapter [06](./06-pty-snapshot-delta.md) §4) — the snapshot crash_log source is `pty_snapshot_write` and the daemon emits `pty_session_degraded` after 3 consecutive snapshot write failures specifically.

**Queue cap and shed-load policy** — the coalescer's per-session queue is capped at `8 MiB` of pending payload bytes. On overflow:

- Pty-host child posts to the daemon main process which checks the cap before enqueuing. If exceeded, the daemon `postMessage`s back `{ kind: "ack", sessionId, seq, status: "RESOURCE_EXHAUSTED" }` to the pty-host child, which translates this into a paused state for the affected session (the child stops draining `node-pty` master events; node-pty's internal kernel-side buffer absorbs the back-pressure until either `claude` blocks or the OS pty buffer fills, at which point `claude` itself blocks on its stdout write). The daemon writes a `crash_log` row (`source = "sqlite_queue_overflow"`, includes session_id and queue depth).
- This bounds daemon RSS during disk-class incidents; the cap (8 MiB) is small enough that it triggers well before OOM but large enough to absorb a few seconds of typical bursty `claude` output.

**WAL discipline** (FOREVER-STABLE) —

- `PRAGMA journal_size_limit = 67108864` (64 MiB) is set at boot (see §3 PRAGMA list); SQLite truncates the `-wal` file to this size after each checkpoint, bounding worst-case `-wal` growth.
- `PRAGMA wal_autocheckpoint = 1000` triggers an automatic PASSIVE checkpoint roughly every 1000 pages (~4 MiB at 4 KiB page size).
- Daemon issues `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown to leave a clean DB on disk.
- Daemon does NOT issue `wal_checkpoint(FULL)` or `wal_checkpoint(RESTART)` during normal operation — these block writers and are only used in maintenance flows (Backup → Export, Recovery).

### 6. Backup and recovery

v0.3 has **no automated backup**. Recovery posture:

- WAL mode + `synchronous = NORMAL` (or `FULL` per Settings) survives process kill with at most the most recent uncommitted transaction lost.
- User-initiated backup: `Settings → Backup → Export` runs `VACUUM INTO '<path>'`; UX in [12](./12-testing-strategy.md) §4 has the test for this.
- Restore: `Settings → Restore` stops sessions, swaps the file, reboots the daemon. v0.3 only. Risky; gated behind a confirmation dialog naming each session that will be terminated.

<!-- F5: closes R3 P0-07-01 (escalated) + R4 P0 ch 07 corrupt-DB recovery — recovery is modal, surfaced to the user, and audit-traceable through a NDJSON sidecar that is written BEFORE the new DB is opened so the recovery event survives even if the post-recovery DB also fails. -->

**Corrupt-DB recovery (FOREVER-STABLE)** — daemon boot ordering for the integrity check:

1. **Open** `state/ccsm.db` read-only via `better-sqlite3` (`{ readonly: true }`); apply `PRAGMA busy_timeout = 5000`.
2. **Run** `PRAGMA integrity_check` (NOT `quick_check` — full check is mandatory at boot; it costs O(seconds) on a multi-MiB DB which is acceptable on the boot path).
3. **Treat any result other than the single string `"ok"` as failure** (R4 P1 ch 07). SQLite returns multiple rows when corruption is found, OR a single row with non-`"ok"` text on partial corruption — both are failures.
4. **On failure** (BEFORE opening any new DB):
   - Compute `corrupt_path = state/ccsm.db.corrupt-<unix_ms>`.
   - `rename` the corrupt DB and its `-wal` / `-shm` siblings to `<corrupt_path>` / `<corrupt_path>-wal` / `<corrupt_path>-shm` atomically. (Failure here is unrecoverable; daemon exits with a fatal log entry to systemd journal / Windows event log / launchd; supervisor restarts and tries again.)
   - **Append a NDJSON line to `state/crash-raw.ndjson`** (NOT to the new SQLite — the new DB doesn't exist yet) with the shape `{"ts_ms": <now>, "source": "sqlite_corruption_recovered", "owner_id": "daemon-self", "summary": "PRAGMA integrity_check returned non-ok; renamed db to <corrupt_path>", "detail": "<integrity_check output, truncated to 64 KiB>"}`. The NDJSON file is the FOREVER-STABLE crash sidecar (chapter [09](./09-crash-collector.md) §1 capture-source `sqlite_corruption_recovered`); it is read on next-successful-boot and replayed into the new `crash_log` table.
   - `fsync` the NDJSON file's directory.
   - **Set the daemon's `recovery_modal_pending` flag** (in-memory boolean exposed via `Supervisor /healthz` JSON `{ ..., "recovery_modal": { "pending": true, "ts_ms": <now>, "corrupt_path": "..." } }`). Electron polls `/healthz` on attach; if `recovery_modal.pending`, it shows a **blocking modal** (NOT a toast) on launch with copy: "ccsm detected database corruption at \<ts\>. Your sessions and crash history could not be recovered. The corrupted database has been preserved at \<path\> for diagnostics. A fresh database has been initialized." with an Acknowledge button that POSTs to Supervisor `/ack-recovery` to clear the flag.
5. **Open** a fresh `state/ccsm.db` read-write; run `001_initial.sql`; record `schema_migrations.version = 1`.
6. **Replay** any NDJSON lines from `state/crash-raw.ndjson` into the new `crash_log` table (chapter [09](./09-crash-collector.md) §3); leave the NDJSON file in place (it's append-only; the daemon tracks a `crash_raw_offset` in a sidecar `state/crash-raw.offset` file to avoid re-replaying on restart).
7. **Continue boot**.

This ordering ensures that even if the new DB fails to open (e.g., disk full immediately after recovery), the corruption event is on disk in a human-readable text file. Step 6 is best-effort; if it fails, the NDJSON line stays unread and is retried on next successful boot.

**Why no in-place repair**: SQLite's `.recover` CLI is not bundled with `better-sqlite3` and a v0.3 daemon does not embed a SQLite shell. Power-loss corruption in WAL mode is rare; the recovery path optimizes for "daemon survives, user is told, original file is preserved for diagnostics" over "daemon attempts magic restoration".

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

### 8. Test inventory (data/state ship-gate verifiability)

<!-- F5: closes R4 P0/P1 ch 07 test-additions — every behavioral lock above gets a named spec file referenced from chapter 12 §3. -->

The following spec files MUST exist and pass in CI before v0.3 ship. Paths are relative to `packages/daemon/`.

| Spec file | Purpose | Closes |
| --- | --- | --- |
| `test/integration/db/migration-lock.spec.ts` | `tools/check-migration-locks.sh` rejects an edited `001_initial.sql`; runtime self-check (`MIGRATION_LOCKS` const) rejects mismatched bundled migrations | R4 P0 ch 07 migration immutability |
| `test/integration/db/integrity-check-recovery.spec.ts` | Inject corruption (truncate `-wal`, scribble random bytes mid-page); daemon boots; `PRAGMA integrity_check` returns non-`"ok"`; daemon renames corrupt files; writes `crash-raw.ndjson` BEFORE opening new DB; `/healthz` reports `recovery_modal.pending = true`; new DB has fresh `001_initial.sql` schema; replays NDJSON into `crash_log` after Acknowledge | R3 P0-07-01 + R4 P0 ch 07 corrupt-DB recovery |
| `test/integration/db/wal-discipline.spec.ts` | Sustained 10 MiB/s write workload for 60 s; assert `-wal` file never exceeds `journal_size_limit` (64 MiB); assert PASSIVE checkpoints fire at ~1000-page boundary; assert `wal_checkpoint(TRUNCATE)` runs on graceful shutdown | R4 P1 ch 07 WAL |
| `test/integration/db/write-coalescer-overflow.spec.ts` | Saturate per-session queue past 8 MiB cap; assert daemon emits `RESOURCE_EXHAUSTED`-equivalent ack to pty-host; assert `crash_log source=sqlite_queue_overflow` row written; assert daemon survives | R4 P1 ch 07 write coalescer backpressure |
| `test/integration/db/disk-full-degraded.spec.ts` | Mount tmpfs with size `<` minimum payload; trigger 3 consecutive write failures; assert session transitions to `DEGRADED`; assert daemon process survives; assert other sessions unaffected | R3 P1-07-03 escalated |
| `test/integration/db/sqlite-synchronous-config.spec.ts` | Set `Settings.sqlite_synchronous = "FULL"`; restart daemon; assert `PRAGMA synchronous` returns 2 (FULL). Set invalid value; assert RPC rejects with `INVALID_ARGUMENT`. | R0 07-P1.2 |
| `test/integration/db/cwd-state-osc7.spec.ts` | Pty-host child receives `ESC ] 7 ; file://host/tmp/foo BEL` in raw VT stream; assert `cwd_state` row UPSERT'd with `cwd = "/tmp/foo"`; restart daemon; assert restored session restarts in `/tmp/foo` not original cwd | R4 P1 ch 07 cwd_state |
