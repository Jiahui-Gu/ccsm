// packages/daemon/src/db/sqlite.ts
//
// Thin wrapper around `better-sqlite3` that opens a database and applies the
// canonical boot-time PRAGMAs spec'd in
// docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//   - chapter 07 §1 (storage choice: SQLite via better-sqlite3, sync driver)
//   - chapter 07 §3 (PRAGMA list applied at boot AFTER opening the connection
//     but BEFORE running migrations)
//
// Scope (Task #54 / T5.1): driver + PRAGMAs only. The migration runner
// (T5.4 / Task #56), the 001_initial.sql schema (T5.2 / Task #55), and the
// WAL discipline + shutdown checkpoint (T5.6 / Task #58) all land in
// separate tasks and MUST NOT be added here.

import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';

/**
 * Re-exported `better-sqlite3` Database type. Callers should import this
 * symbol rather than reaching into `better-sqlite3` directly so that the
 * daemon has a single typed surface for the driver (eases future swap or
 * patch-pinning).
 */
export type SqliteDatabase = BetterSqlite3Database;

/**
 * Boot-time PRAGMA values (ch07 §3). Frozen so callers can assert against
 * the same constants the wrapper applies — tests in `__tests__/sqlite.spec.ts`
 * rely on this.
 */
export const BOOT_PRAGMAS = Object.freeze({
  /** WAL mode is mandatory for the daemon's reader/writer concurrency model. */
  journal_mode: 'wal',
  /** NORMAL is the default per ch07 §3; configurable per Settings in T-later. */
  synchronous: 'NORMAL',
  /** ON enables FK enforcement — required by the v0.3 schema. */
  foreign_keys: 'ON',
  /** 5000 ms — bounds writer-contention waits (ch07 §3). */
  busy_timeout: 5000,
  /** 64 MiB cap on -wal file growth (ch07 §3 / §5 WAL discipline). */
  journal_size_limit: 67108864,
} as const);

export interface OpenDatabaseOptions {
  /** Open the database read-only. Used by the boot integrity-check path
   *  (ch07 §4 step 1). Defaults to `false` (read/write). */
  readonly?: boolean;
}

/**
 * Open a SQLite database at `path` and apply the canonical boot-time
 * PRAGMAs from ch07 §3.
 *
 * Order matters per spec: PRAGMAs are applied **after** the connection is
 * open and **before** any migration / schema work. `journal_mode = WAL` is
 * applied first because subsequent PRAGMAs implicitly assume WAL semantics
 * (notably `journal_size_limit`).
 *
 * On any PRAGMA failure the connection is closed before re-throwing so the
 * caller never sees a half-configured handle.
 *
 * @param path Filesystem path to the database file. Use `':memory:'` for
 *   in-process tests (still receives the full PRAGMA suite — the wrapper
 *   does not special-case it).
 * @param options Optional read-only flag (used by integrity-check path).
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const db: SqliteDatabase = new Database(path, {
    readonly: options.readonly ?? false,
  });

  try {
    // WAL must come first — other PRAGMAs (journal_size_limit) assume it.
    db.pragma(`journal_mode = ${BOOT_PRAGMAS.journal_mode}`);
    db.pragma(`synchronous = ${BOOT_PRAGMAS.synchronous}`);
    db.pragma(`foreign_keys = ${BOOT_PRAGMAS.foreign_keys}`);
    db.pragma(`busy_timeout = ${BOOT_PRAGMAS.busy_timeout}`);
    db.pragma(`journal_size_limit = ${BOOT_PRAGMAS.journal_size_limit}`);
  } catch (err) {
    // Don't leak a half-configured handle on PRAGMA failure.
    try {
      db.close();
    } catch {
      // best-effort
    }
    throw err;
  }

  return db;
}
