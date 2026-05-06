import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Wave-2 A: this module moved out of electron/ into daemon/. The daemon is a
// plain Node process and has no `electron.app.getPath('userData')` to ask for
// the per-user data directory, so we accept it via the `CCSM_USER_DATA_DIR`
// env var (electron sets this in `daemon-spawner` before launching us). When
// the env var is missing — typical for a one-off `node dist/daemon/main.js`
// dev probe — we fall back to `<os.tmpdir()>/ccsm-daemon` so smoke tests still
// work; we log the fallback so a misconfigured prod boot is visible. The DB
// file name (`ccsm.db`) and on-disk schema are unchanged.
function resolveUserDataDir(): string {
  const fromEnv = process.env.CCSM_USER_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const fallback = path.join(os.tmpdir(), 'ccsm-daemon');
  process.stderr.write(
    `[db] CCSM_USER_DATA_DIR not set; falling back to ${fallback}\n`,
  );
  return fallback;
}

let db: Database.Database | null = null;

// ── Storage health (Task #639) ──────────────────────────────────────────────
// Surfaces initDb failure to the UI instead of swallowing it. The daemon
// stays up so the user can see logs / quit cleanly, but every db op short-
// circuits with a 503 + reason and the renderer paints a fatal banner.
//
// Three sources can mark storage unhealthy:
//   1. initDb itself throws (better-sqlite3 ABI mismatch, EACCES on the
//      userdata dir, ENOSPC on the WAL write, sqlite header corruption that
//      survived ensureHealthyDb).
//   2. CCSM_TEST_BREAK_DB=1 — a test/e2e seam that forces initDb to throw
//      before touching disk so the failure path is reproducible without
//      manually corrupting a live db.
//   3. (future) a runtime saveState that throws SQLITE_FULL / SQLITE_IOERR
//      could promote itself here too. Out of scope for this PR — initDb
//      coverage is the v0.3 ship-blocker.
//
// This is intentionally a module-level singleton (NOT a slice on `db`)
// because it must survive `db === null` — the whole point is "we never got
// a handle".
export interface StorageHealth {
  ok: boolean;
  reason?: string;
}

let storageHealth: StorageHealth = { ok: true };

export function getStorageHealth(): StorageHealth {
  return storageHealth;
}

/** Mark storage as unhealthy. Called by startup when initDb throws and
 *  preserved across the rest of the process lifetime — sqlite errors at
 *  this layer don't recover without a restart. */
export function markStorageUnhealthy(reason: string): void {
  storageHealth = { ok: false, reason };
}

/** Test-only: reset health back to ok between unit-test cases. */
export function __resetStorageHealthForTests(): void {
  storageHealth = { ok: true };
}

// Schema version for the on-disk SQLite layout. Bumped only when the table
// shapes change in a way readers care about. Use `PRAGMA user_version` so
// SQLite stores it for us — no extra metadata table required.
//
// Migration policy: on a fresh DB (`user_version === 0`), we run the current
// schema and stamp it. On a downgrade (stored > current) we log a warning
// and proceed; better-sqlite3 will tolerate unknown columns/indexes added by
// a future version. Real upgrades land in `migrate()` below — empty for now
// because v1 is the only shipped version.
const SCHEMA_VERSION = 1;

// ── Cached prepared statements ───────────────────────────────────────────────
// better-sqlite3 caches compiled SQL inside each Statement object, but the
// JavaScript-side allocation/lookup still costs ~10 microseconds per call.
// For hot paths (saveState on every keystroke in the composer draft persister)
// that adds up. Cache the Statement once per process lifetime; reset to null
// when the underlying db closes so the next initDb() rebuilds them.
type PreparedCache = {
  loadState: Database.Statement<[string]> | null;
  upsertState: Database.Statement<[string, string, number]> | null;
  deleteState: Database.Statement<[string]> | null;
};

const stmts: PreparedCache = {
  loadState: null,
  upsertState: null,
  deleteState: null
};

function resetStmts(): void {
  stmts.loadState = null;
  stmts.upsertState = null;
  stmts.deleteState = null;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

/**
 * Schema migration stub. Empty for v1 — the only shipped schema. Future
 * upgrades (e.g. adding a column or index) will go here as a switch on
 * `from`. Kept as a function (not a no-op inline) so unit tests can spy
 * on it once we have real migrations.
 */
function migrate(_from: number, _to: number): void {
  // No migrations defined yet. When SCHEMA_VERSION bumps to 2+, branch on
  // `_from` and apply the deltas inside a single transaction. Always bump
  // user_version at the end so a partial migration doesn't leave the DB
  // claiming to be on the new version.
}

/**
 * Run SQLite's `quick_check` and, if the file is corrupt, move it aside
 * and replace it with a fresh empty database. Returns the (possibly new)
 * Database handle.
 *
 * `quick_check` skips the cross-table consistency phase that
 * `integrity_check` runs, which is fine as a startup gate: we only need to
 * detect torn-page or header corruption that would cause every subsequent
 * read to throw. Cost is roughly proportional to db size; on a fresh DB
 * (the common case) it returns in microseconds.
 */
function ensureHealthyDb(file: string, current: Database.Database): Database.Database {
  let result: string | null = null;
  try {
    const row = current.pragma('quick_check', { simple: true });
    result = typeof row === 'string' ? row : null;
  } catch (err) {
    // The pragma itself threw — treat the same as corruption.
    console.error('[db] quick_check threw, treating as corruption:', err);
  }
  if (result === 'ok') return current;

  console.error(
    `[db] integrity check failed (result=${JSON.stringify(result)}); backing up and starting fresh`
  );
  try {
    current.close();
  } catch {
    // already closed / never opened cleanly — ignore
  }
  const ts = Date.now();
  const backup = `${file}.corrupt-${ts}`;
  try {
    fs.renameSync(file, backup);
    console.error(`[db] corrupt database moved to ${backup}`);
  } catch (err) {
    // If we can't rename (file locked, missing, etc.) fall back to deleting
    // so the next `new Database()` gets a clean slate. Logging both paths
    // helps post-mortem when a user reports "my data vanished".
    console.error('[db] failed to back up corrupt db, removing instead:', err);
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore — `new Database` will create one
    }
  }
  // Also clear sidecar WAL/SHM files so SQLite doesn't try to replay a
  // journal pointing at the now-renamed main file.
  for (const ext of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(file + ext);
    } catch {
      // ignore — they may not exist
    }
  }
  return new Database(file);
}

export function initDb(): Database.Database {
  if (db) return db;
  // Test/e2e seam — force the failure path without corrupting a real db
  // on disk. Reproduces the dogfood-575 P0 (Task #639) where the user's
  // data evaporates because db init silently fails. Setting this env var
  // anywhere in the spawn chain makes initDb throw a deterministic error
  // so the harness can assert the StorageHealthBanner appears + no
  // db:save returns silent-fail.
  if (process.env.CCSM_TEST_BREAK_DB === '1') {
    throw new Error('CCSM_TEST_BREAK_DB=1 (forced storage init failure for testing)');
  }
  const dir = resolveUserDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ccsm.db');

  let handle = new Database(file);
  handle = ensureHealthyDb(file, handle);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.exec(SCHEMA_SQL);

  // Schema versioning. `user_version` defaults to 0 on a brand-new file.
  const stored = handle.pragma('user_version', { simple: true }) as number;
  if (stored === 0) {
    handle.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (stored < SCHEMA_VERSION) {
    migrate(stored, SCHEMA_VERSION);
    handle.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (stored > SCHEMA_VERSION) {
    // Downgrade scenario (user installed v0.3, then rolled back to v0.2).
    // We don't refuse to boot — that's worse than risking a stale read —
    // but we shout in the log so a bug report includes the breadcrumb.
    console.warn(
      `[db] on-disk schema version ${stored} is newer than app's ${SCHEMA_VERSION}; proceeding read-as-is`
    );
  }

  // Drop legacy tables that earlier ccsm versions wrote but the app no
  // longer reads:
  //   - `endpoints` / `endpoint_models`: connection config now comes from
  //     ~/.claude/settings.json.
  //   - `messages`: session history now reads from CLI's
  //     ~/.claude/projects/<key>/<sid>.jsonl (PR-H). The SQLite copy was a
  //     redundant secondary write. We deliberately do NOT migrate the old
  //     rows — for users who never persisted via ccsm pre-rename, JSONL
  //     already has the canonical history; for users who somehow have rows
  //     in `messages` but missing JSONL, a one-line fallback isn't worth
  //     the migration footprint (per project decision: "no migration for
  //     old users").
  // Cheap to issue at every boot; SQLite ignores missing tables.
  handle.exec(`
    DROP TABLE IF EXISTS endpoint_models;
    DROP TABLE IF EXISTS endpoints;
    DROP INDEX IF EXISTS idx_messages_session;
    DROP TABLE IF EXISTS messages;
  `);

  db = handle;
  return db;
}

// Test-only: swap in an in-memory database. Never call from app code.
export function __setDbForTests(instance: Database.Database | null): void {
  db = instance;
  resetStmts();
  if (instance) {
    instance.pragma('foreign_keys = ON');
    instance.exec(SCHEMA_SQL);
  }
}

export function getDb(): Database.Database {
  return initDb();
}

export function loadState(key: string): string | null {
  const d = initDb();
  if (!stmts.loadState) {
    stmts.loadState = d.prepare('SELECT value FROM app_state WHERE key = ?');
  }
  const row = stmts.loadState.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function saveState(key: string, value: string): void {
  const d = initDb();
  if (!stmts.upsertState) {
    stmts.upsertState = d.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
  }
  stmts.upsertState.run(key, value, Date.now());
}

export function closeDb(): void {
  db?.close();
  db = null;
  resetStmts();
}

// `claudeBinPath` was previously persisted in `app_state` so users could
// "browse for a claude binary" via the now-deleted first-run wizard (PR-I).
// CCSM ships the binary inside the installer (PR-B) so the renderer never
// needs to override it; the load/save helpers + the row are gone, but the
// `app_state` table itself stays for other keys (crashReportingOptOut etc.).
