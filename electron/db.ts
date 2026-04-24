import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let db: Database.Database | null = null;

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
// For hot paths (loadMessages on session switch, saveState on every keystroke
// in the composer draft persister) that adds up. Cache the Statement once
// per process lifetime; reset to null when the underlying db closes so the
// next initDb() rebuilds them.
type PreparedCache = {
  loadMessages: Database.Statement<[string]> | null;
  deleteMessagesForSession: Database.Statement<[string]> | null;
  insertMessage: Database.Statement<[string, string, string, string, number]> | null;
  loadState: Database.Statement<[string]> | null;
  upsertState: Database.Statement<[string, string, number]> | null;
  deleteState: Database.Statement<[string]> | null;
};

const stmts: PreparedCache = {
  loadMessages: null,
  deleteMessagesForSession: null,
  insertMessage: null,
  loadState: null,
  upsertState: null,
  deleteState: null
};

function resetStmts(): void {
  stmts.loadMessages = null;
  stmts.deleteMessagesForSession = null;
  stmts.insertMessage = null;
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
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
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
  const dir = app.getPath('userData');
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

  // Drop legacy endpoints tables if they exist from a pre-refactor install.
  // The app no longer reads them — connection config now comes from
  // ~/.claude/settings.json. Cheap to issue at every boot; SQLite ignores
  // missing tables.
  handle.exec(`
    DROP TABLE IF EXISTS endpoint_models;
    DROP TABLE IF EXISTS endpoints;
  `);

  db = handle;
  return db;
}

export function loadMessages(sessionId: string): unknown[] {
  const d = initDb();
  if (!stmts.loadMessages) {
    stmts.loadMessages = d.prepare(
      'SELECT id, content FROM messages WHERE sessionId = ? ORDER BY createdAt ASC'
    );
  }
  const rows = stmts.loadMessages.all(sessionId) as Array<{ id: string; content: string }>;
  // A corrupt or hand-edited row should not crash the entire session load —
  // skip the offender and surface a console warning so we can grep logs
  // post-mortem. The user sees a session with N-1 messages, not a blank
  // pane and a stuck "Loading…" spinner.
  const out: unknown[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.content));
    } catch {
      console.warn('[db] corrupt message row sessionId=%s id=%s', sessionId, r.id);
    }
  }
  return out;
}

export function saveMessages(sessionId: string, blocks: Array<{ id: string; kind: string }>): void {
  const d = initDb();
  if (!stmts.deleteMessagesForSession) {
    stmts.deleteMessagesForSession = d.prepare('DELETE FROM messages WHERE sessionId = ?');
  }
  if (!stmts.insertMessage) {
    stmts.insertMessage = d.prepare(
      'INSERT INTO messages (id, sessionId, kind, content, createdAt) VALUES (?, ?, ?, ?, ?)'
    );
  }
  const del = stmts.deleteMessagesForSession;
  const ins = stmts.insertMessage;
  const tx = d.transaction(() => {
    del.run(sessionId);
    const now = Date.now();
    blocks.forEach((block, i) => {
      // Use index-based createdAt tiebreaker so ordering is stable even when
      // many blocks land in the same millisecond.
      ins.run(block.id, sessionId, block.kind, JSON.stringify(block), now + i);
    });
  });
  tx();
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

const CLAUDE_BIN_PATH_KEY = 'claudeBinPath';

/**
 * Load the persisted user-picked claude binary path (the "Browse for binary"
 * flow in the first-run wizard). Returns `null` when the user has not picked
 * one; caller falls back to `CCSM_CLAUDE_BIN` env then PATH.
 */
export function loadClaudeBinPath(): string | null {
  return loadState(CLAUDE_BIN_PATH_KEY);
}

export function saveClaudeBinPath(value: string | null): void {
  if (value == null || value.length === 0) {
    const d = initDb();
    if (!stmts.deleteState) {
      stmts.deleteState = d.prepare('DELETE FROM app_state WHERE key = ?');
    }
    stmts.deleteState.run(CLAUDE_BIN_PATH_KEY);
    return;
  }
  saveState(CLAUDE_BIN_PATH_KEY, value);
}
