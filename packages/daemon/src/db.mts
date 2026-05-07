// KV-only SQLite persistence for the ccsm daemon (Task #666).
//
// Design:
//   - Single table `app_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`.
//   - WAL journal mode for concurrent reader friendliness; foreign_keys ON for
//     forward-compat in case future tables grow relationships.
//   - `user_version = 1` is hard-coded. There is no migration framework yet —
//     when schema changes, bump the version and add explicit handling.
//   - Default DB path:
//       Windows: %APPDATA%/ccsm/ccsm.db
//       *nix:    ~/.ccsm/ccsm.db
//     Legacy fallback: if the new path has no db file but a legacy
//     `ccsm-web/ccsm.db` exists at the corresponding old location, the legacy
//     file is opened in place (with a stderr warning) so users keep their data
//     after the ccsm-web → ccsm rename. No automatic migration — the legacy
//     file is read where it is.
//   - Corruption recovery: on open, run `PRAGMA quick_check`. If it returns
//     anything other than 'ok', rename the db / wal / shm files to
//     `<name>.corrupt-<timestamp>` and re-open a fresh empty db. This mirrors
//     the desktop ccsm-research/electron/db.ts approach (without its IPC layer).
//
// Public surface is intentionally tiny — the daemon only needs string KV today.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface KvDb {
  get(key: string): string | null;
  set(key: string, value: string): void;
  close(): void;
}

export interface OpenDbOptions {
  path?: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const USER_VERSION = 1;

export function defaultDbPath(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming');
    return path.join(base, 'ccsm', 'ccsm.db');
  }
  return path.join(os.homedir(), '.ccsm', 'ccsm.db');
}

/**
 * Legacy default db path (pre `ccsm-web` → `ccsm` repo rename, 2026-05).
 * Kept so existing users don't lose their KV state after upgrading: if no db
 * exists at {@link defaultDbPath} but one exists here, we open the legacy file
 * in place. No automatic copy/migration.
 */
export function legacyDefaultDbPath(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming');
    return path.join(base, 'ccsm-web', 'ccsm.db');
  }
  return path.join(os.homedir(), '.ccsm-web', 'ccsm.db');
}

/**
 * Resolve the effective default db path, preferring the new location but
 * falling back to the legacy `ccsm-web` location when the new file is absent
 * and the legacy file exists. Emits a single stderr warning when the legacy
 * fallback is taken.
 */
export function resolveDefaultDbPath(): string {
  const current = defaultDbPath();
  if (fs.existsSync(current)) return current;
  const legacy = legacyDefaultDbPath();
  if (legacy !== current && fs.existsSync(legacy)) {
    process.stderr.write(
      `ccsm: using legacy db at ${legacy} (move to ${current} to silence this warning)\n`,
    );
    return legacy;
  }
  return current;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Best-effort rename to `<file>.corrupt-<ts>`. Missing files are silently
 * skipped (e.g. -wal/-shm only exist when WAL mode has been engaged).
 */
function backupCorruptFiles(dbPath: string, ts: number): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (!fs.existsSync(src)) continue;
    const dst = `${dbPath}${suffix}.corrupt-${ts}`;
    try {
      fs.renameSync(src, dst);
    } catch {
      // If rename fails (e.g. file locked) try to unlink so the next open
      // is not blocked. Worst case better-sqlite3 will throw on reopen and
      // surface a clearer error.
      try {
        fs.unlinkSync(src);
      } catch {
        // give up silently — next open will report the real error
      }
    }
  }
}

/**
 * Open the database file at `dbPath`. Runs `PRAGMA quick_check` and, if it
 * reports corruption, backs up the existing files and returns a fresh handle
 * to a brand-new empty db at the same path.
 */
function openWithCorruptionGuard(dbPath: string): Database.Database {
  ensureParentDir(dbPath);
  let db = new Database(dbPath);
  let check: unknown;
  try {
    check = db.pragma('quick_check', { simple: true });
  } catch (err) {
    // If quick_check itself throws, treat as corrupt.
    check = String(err);
  }
  if (check !== 'ok') {
    try {
      db.close();
    } catch {
      // ignore — file was likely unusable
    }
    backupCorruptFiles(dbPath, Date.now());
    db = new Database(dbPath);
  }
  return db;
}

function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${USER_VERSION}`);
}

export function openDb(opts?: OpenDbOptions): KvDb {
  const dbPath = opts?.path ?? resolveDefaultDbPath();
  const db = openWithCorruptionGuard(dbPath);
  applySchema(db);

  const getStmt = db.prepare<[string], { value: string }>(
    'SELECT value FROM app_state WHERE key = ?',
  );
  const setStmt = db.prepare<[string, string, number]>(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  return {
    get(key: string): string | null {
      const row = getStmt.get(key);
      return row ? row.value : null;
    },
    set(key: string, value: string): void {
      setStmt.run(key, value, Date.now());
    },
    close(): void {
      db.close();
    },
  };
}
