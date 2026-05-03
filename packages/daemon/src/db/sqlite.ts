// packages/daemon/src/db/sqlite.ts
//
// Thin wrapper around `better-sqlite3` that opens a database and applies the
// canonical boot-time PRAGMAs spec'd in
// docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//   - chapter 07 §1 (storage choice: SQLite via better-sqlite3, sync driver)
//   - chapter 07 §3 (PRAGMA list applied at boot AFTER opening the connection
//     but BEFORE running migrations)
//   - chapter 07 §5 (WAL discipline: wal_autocheckpoint + TRUNCATE on
//     graceful shutdown)
//
// Scope (Task #54 / T5.1): driver + boot PRAGMAs.
// Scope (Task #58 / T5.6): WAL discipline — wal_autocheckpoint = 1000 added
// to the boot PRAGMA suite plus standalone helpers `walCheckpointPassive()`
// and `walCheckpointTruncate()` for periodic / shutdown use. The migration
// runner (T5.4 / Task #56), the 001_initial.sql schema (T5.2 / Task #55),
// and crash/ recovery (#59) all live in separate tasks and MUST NOT land
// here.

import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';

/**
 * Re-exported `better-sqlite3` Database type. Callers should import this
 * symbol rather than reaching into `better-sqlite3` directly so that the
 * daemon has a single typed surface for the driver (eases future swap or
 * patch-pinning).
 */
export type SqliteDatabase = BetterSqlite3Database;

/**
 * Boot-time PRAGMA values (ch07 §3 + §5). Frozen so callers can assert
 * against the same constants the wrapper applies — tests in
 * `__tests__/sqlite.spec.ts` rely on this.
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
  /**
   * 1000 pages (~4 MiB at the default 4 KiB page size) — SQLite triggers an
   * automatic PASSIVE checkpoint when the -wal file reaches this many frames.
   * Spec: ch07 §3 Settings table (`wal_autocheckpoint_pages`, default 1000,
   * range 100–100000) + ch07 §5 WAL discipline. Runtime override from
   * Settings lands in a later task; T5.6 locks the default at boot.
   */
  wal_autocheckpoint: 1000,
} as const);

export interface OpenDatabaseOptions {
  /** Open the database read-only. Used by the boot integrity-check path
   *  (ch07 §4 step 1). Defaults to `false` (read/write). */
  readonly?: boolean;
}

/**
 * Open a SQLite database at `path` and apply the canonical boot-time
 * PRAGMAs from ch07 §3 + §5.
 *
 * Order matters per spec: PRAGMAs are applied **after** the connection is
 * open and **before** any migration / schema work. `journal_mode = WAL` is
 * applied first because subsequent PRAGMAs implicitly assume WAL semantics
 * (notably `journal_size_limit` and `wal_autocheckpoint`).
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
    // WAL must come first — other PRAGMAs (journal_size_limit,
    // wal_autocheckpoint) assume it.
    db.pragma(`journal_mode = ${BOOT_PRAGMAS.journal_mode}`);
    db.pragma(`synchronous = ${BOOT_PRAGMAS.synchronous}`);
    db.pragma(`foreign_keys = ${BOOT_PRAGMAS.foreign_keys}`);
    db.pragma(`busy_timeout = ${BOOT_PRAGMAS.busy_timeout}`);
    db.pragma(`journal_size_limit = ${BOOT_PRAGMAS.journal_size_limit}`);
    // wal_autocheckpoint only takes effect on a WAL-mode connection; safe
    // to skip when read-only (PRAGMA is allowed but moot since no writes
    // append to -wal through this handle).
    if (options.readonly !== true) {
      db.pragma(`wal_autocheckpoint = ${BOOT_PRAGMAS.wal_autocheckpoint}`);
    }
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

// ---------------------------------------------------------------------------
// WAL discipline — checkpoint helpers (ch07 §5).
//
// `wal_autocheckpoint = 1000` covers the steady-state case automatically.
// These helpers expose the explicit checkpoint modes the daemon needs at
// quiet-period flushes (PASSIVE) and graceful shutdown (TRUNCATE).
//
// Modes intentionally NOT exposed: FULL and RESTART. Per ch07 §5, these
// block writers and are reserved for maintenance flows (Backup → Export,
// Recovery) — not normal operation. Adding them here would be a footgun.
// ---------------------------------------------------------------------------

/**
 * Shape of a `PRAGMA wal_checkpoint(...)` result row, as returned by
 * `better-sqlite3`'s typed `pragma()` call. SQLite returns three columns:
 *   - `busy`: 0 if the checkpoint completed, 1 if any writer/reader was
 *     blocking PASSIVE from finishing.
 *   - `log`: total number of frames in the -wal file at start.
 *   - `checkpointed`: number of frames moved into the main DB and (for
 *     TRUNCATE) flushed before truncation.
 *
 * Returned to callers so observability / metrics layers can log progress
 * without re-running the PRAGMA.
 */
export interface WalCheckpointResult {
  busy: 0 | 1;
  log: number;
  checkpointed: number;
}

function runCheckpoint(db: SqliteDatabase, mode: 'PASSIVE' | 'TRUNCATE'): WalCheckpointResult {
  // better-sqlite3 returns an array of rows for `pragma()` without
  // `{ simple: true }`. `wal_checkpoint(<mode>)` always returns a single
  // row with the three columns described above.
  const rows = db.pragma(`wal_checkpoint(${mode})`) as ReadonlyArray<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  const row = rows[0];
  if (row === undefined) {
    // Shouldn't happen — SQLite always returns a row for wal_checkpoint —
    // but guard so a future driver change doesn't silently return NaN.
    throw new Error(`wal_checkpoint(${mode}) returned no rows`);
  }
  return {
    busy: row.busy === 0 ? 0 : 1,
    log: row.log,
    checkpointed: row.checkpointed,
  };
}

/**
 * Issue `PRAGMA wal_checkpoint(PASSIVE)` — non-blocking checkpoint that
 * skips any frames currently held by readers/writers. Use during quiet
 * periods to keep the -wal file from growing unbounded between automatic
 * checkpoints (ch07 §5).
 *
 * Caller is responsible for the cadence; this helper is one-shot.
 *
 * @returns The checkpoint result row (`busy`/`log`/`checkpointed`).
 */
export function walCheckpointPassive(db: SqliteDatabase): WalCheckpointResult {
  return runCheckpoint(db, 'PASSIVE');
}

/**
 * Issue `PRAGMA wal_checkpoint(TRUNCATE)` — checkpoints all frames AND
 * truncates the `-wal` file to zero bytes. Spec ch07 §5: "Daemon issues
 * `PRAGMA wal_checkpoint(TRUNCATE)` on graceful shutdown to leave a clean
 * DB on disk."
 *
 * MUST be called BEFORE `db.close()` — once the handle is closed the
 * PRAGMA fails and the -wal/-shm files are left on disk for the next boot
 * to replay.
 *
 * @returns The checkpoint result row. `busy === 1` indicates another
 *   connection still held frames; the daemon should still proceed with
 *   shutdown (a non-clean -wal is a correctness-preserving outcome since
 *   SQLite replays it on next open).
 */
export function walCheckpointTruncate(db: SqliteDatabase): WalCheckpointResult {
  return runCheckpoint(db, 'TRUNCATE');
}
