# 10 — SQLite + DbService

## Scope

SQLite lives **inside the daemon**, not in the Electron app. Electron accesses persisted state only through Connect-RPC `DbService` over Listener A.

**Why:** final-architecture §2 principle 1 (backend owns state). Electron-side SQLite would force a state-sync contract between Electron and daemon — the exact "two sources of truth" hazard the architecture forbids. Reconciliation #56 MODIFY: items 1-3 (deps, bootOrchestrator wiring, dataRoot) survived; item 4-5 (RPC handlers) deferred to Connect-RPC — this chapter pins them as Connect.

## File location

- Path: `<dataRoot>/data/ccsm.db`.
- `<dataRoot>` policy is the unified one from reconciliation #58 + #63 (KEEP/MODIFY): single source of truth, per-OS:
  - macOS: `~/Library/Application Support/ccsm/`
  - Linux: `${XDG_DATA_HOME or ~/.local/share}/ccsm/`
  - Windows: `%LOCALAPPDATA%\ccsm\`
- Owner-only ACL (mode 0700 on POSIX; owner-only DACL on Windows).

## Schema (v0.3)

```sql
-- Session metadata only (scrollback is RAM-only; see chapter 08)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- ULID
  title TEXT,
  color TEXT,
  cwd TEXT,
  shell TEXT,
  created_at INTEGER NOT NULL,    -- ms epoch
  closed_at INTEGER,
  exit_code INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_created_at ON sessions(created_at DESC);

-- Generic key-value for app state (DbService surface)
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Crash reports (see chapter 11)
CREATE TABLE crash_reports (
  id TEXT PRIMARY KEY,            -- ULID
  source TEXT NOT NULL,           -- 'renderer' | 'electron-main' | 'daemon'
  occurred_at INTEGER NOT NULL,
  payload BLOB NOT NULL,          -- serialized Sentry envelope
  uploaded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX crash_reports_occurred_at ON crash_reports(occurred_at DESC);

-- Schema version pin
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY     -- single row, value = current schema version
);
INSERT OR REPLACE INTO schema_version (version) VALUES (3);
```

`PRAGMA journal_mode=WAL;` + `PRAGMA synchronous=NORMAL;` set at open.

## Migration from v0.2

Existing v0.2 daemon-less Electron apps wrote to a different schema/location (see existing `frag-8` migration design — reconciliation #56 KEEPs items 1-3 + 6 = the migration logic). The migration code:

1. On daemon boot, opens `<dataRoot>/data/ccsm.db`. If absent and a v0.2 DB is found at the legacy location → run migration.
2. Migration is a single transaction; on any failure → leave new DB absent, surface a Quit-only error modal in Electron (the v0.3 frag-8 "no in-place retry" rule).
3. Until migration completes, daemon is in `MIGRATION_PENDING` state.

### `MIGRATION_PENDING` semantics on Connect data plane

Replaces the v0.3-old envelope `MIGRATION_PENDING` short-circuit. Implementation: a Connect interceptor `daemon/src/connect/interceptors/migration-gate.ts` mounted on the data-plane handler chain that:

- Allows: nothing on the data plane (no allowlist; data plane is gated entirely until DB is ready).
- Returns: `FailedPrecondition` with message `"daemon db migration pending"` for every RPC.

The supervisor plane is unaffected (existing supervisor envelope migration-gate keeps its allowlist of `daemon.hello`, `/healthz`, `shutdown*`).

**Why on data plane no allowlist:** the only data-plane RPC that a client could legitimately need during migration would be `daemon.Info`, but `daemon.Info` is also available via supervisor `daemon.hello` for boot-time use. Keeping the data plane simple = "everything fails until DB is ready" is clearer than maintaining two parallel allowlists.

## DbService implementation

`daemon/src/connect/handlers/db.ts`:

- Wraps `better-sqlite3` (or sqlite3 — choose by Win prebuild availability + Node 22 ABI; spec defers exact choice to implementer per [16](./16-risks-and-open-questions.md)).
- `Get`: `SELECT value FROM app_state WHERE key = ?`. Missing → `NotFound`.
- `Set`: `INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)`.
- `List`: `SELECT key FROM app_state WHERE key LIKE ? || '%'` with optional prefix.
- `Delete`: `DELETE FROM app_state WHERE key = ?`.

Values are bytes; the encoding (JSON, msgpack, raw) is the client's choice. The handler does not interpret.

Performance: all DbService methods are synchronous SQLite calls; better-sqlite3 is sync-API; total latency target < 1 ms for app_state-sized writes.

## Sessions persistence

Session-manager writes to `sessions` table on:

- `create` — `INSERT`.
- `update` (metadata) — `UPDATE` for `title`, `color`, `pinned` only.
- `close` — `UPDATE SET closed_at, exit_code`.

Session list / get RPCs (`SessionsService.List`, `Get`) read from this table joined with the in-memory active-session registry (active sessions overlay metadata + add `state: ACTIVE`).

## dataRoot CLI override

`ccsm-daemon --data-root <path>` overrides default. Used by the test harness to isolate per-test storage and by dev to point at a worktree-local directory.

## What this chapter does NOT cover

- Scrollback persistence — RAM-only in v0.3, see [08](./08-session-model.md).
- Crash payload schema details — see [11](./11-crash-and-observability.md).
- Daemon-side encryption-at-rest — out of scope; the OS-level home-dir permissions are the trust boundary in v0.3, matching the v0.2 baseline.

## Cross-refs

- [01 — Goals](./01-goals-and-non-goals.md)
- [06 — Proto (DbService surface)](./06-proto-schema.md)
- [07 — Connect server (handler wiring)](./07-connect-server.md)
- [08 — Session model (sessions table is metadata-only)](./08-session-model.md)
- [11 — Crash + observability (crash_reports table)](./11-crash-and-observability.md)
- [12 — Electron thin client (consumes DbService for prefs)](./12-electron-thin-client.md)
- [16 — Risks (better-sqlite3 vs sqlite3 choice)](./16-risks-and-open-questions.md)
