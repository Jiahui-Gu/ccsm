// packages/daemon/src/db/migrations/runner.ts
//
// Migration runner. Spec ch07 §4 (forward-only migrations + immutability lock).
//
// Responsibilities:
//   1. Ensure `schema_migrations` table exists (bootstrap-safe).
//   2. SELF-CHECK: for every row already in `schema_migrations`, verify the
//      bundled migration's SHA256 matches the entry in MIGRATION_LOCKS.
//      Mismatch = abort startup with an explicit error (ch07 §4 immutability
//      lock — "v0.3 migration files are immutable after v0.3 ships"). The
//      release body of v0.3.0 is the source of truth (cross-checked in CI by
//      tools/check-migration-locks.sh); this self-check guards against a
//      tampered or corrupted bundled payload post-install.
//   3. Determine pending migrations (lock entries whose `version` exceeds
//      `MAX(schema_migrations.version)`). Apply them in order, each in a
//      transaction that wraps the SQL exec + `INSERT INTO schema_migrations`
//      so a partial apply rolls back atomically.
//
// Bundled-payload resolution (Task #463 / P0 ship blocker — was P0 cause of
// daemon SEA crash):
//
//   The runner used to read `*.sql` files via `readFileSync(...)` resolved
//   from `dirname(fileURLToPath(import.meta.url))`. esbuild rewrites
//   `import.meta.url` in `bundle.cjs` to a `__filename` shim that is
//   undefined inside a postjected SEA binary, so the daemon crashed at
//   `OPENING_DB` (dev round-3 traced it to `dist/bundle.cjs:6961`). The fix
//   is to inline every migration's SQL bytes into a TS module
//   (`./inlined.ts`) at build time via `build/inline-migrations.mjs`. The
//   runner now reads SQL from `MIGRATION_SQL[filename]` — zero filesystem
//   dependency, works identically in dev (tsc), tests (vitest), and SEA.
//
//   SHA256 verification is preserved exactly: the runner hashes the inlined
//   bytes and compares against `MIGRATION_LOCKS[].sha256`. Tampering with
//   `inlined.ts` is caught by `MigrationLockMismatchError` exactly as a
//   tampered on-disk SQL file would have been.
//
// Out of scope here:
//   - Driver / PRAGMAs (T5.1, packages/daemon/src/db/sqlite.ts).
//   - WAL discipline / checkpoints (T5.6).
//   - v0.2 → v0.3 user-data migration (one-shot installer-driven; ch07 §4.5).

import { createHash } from 'node:crypto';

import type { SqliteDatabase } from '../sqlite.js';

import { MIGRATION_LOCKS, type MigrationLock } from '../locked.js';
import { MIGRATION_SQL } from './inlined.js';

/**
 * Result of a single `runMigrations()` call. `applied` lists the migrations
 * that this call applied (in order). `alreadyApplied` lists the migrations
 * that were already present in `schema_migrations` and passed the SHA256
 * self-check. Useful for logging at boot.
 */
export interface MigrationRunResult {
  readonly applied: readonly MigrationLock[];
  readonly alreadyApplied: readonly MigrationLock[];
}

/**
 * Custom error class — thrown when the SHA256 of a bundled migration
 * does not match the locked value. Caller (daemon entrypoint) treats this
 * as a hard startup failure; the daemon must not advance past
 * `OPENING_DB`. Message format is intentionally explicit (filename,
 * expected, actual) so the install-log scrape (ch10 §6) surfaces the
 * exact mismatch without grepping multiple lines.
 */
export class MigrationLockMismatchError extends Error {
  constructor(
    public readonly filename: string,
    public readonly expectedSha256: string,
    public readonly actualSha256: string,
  ) {
    super(
      `migration lock mismatch for ${filename}: expected sha256=${expectedSha256}, actual=${actualSha256}. ` +
        `This file is FOREVER-STABLE per design ch07 §4; a mismatch means the bundled migration was tampered ` +
        `with post-build or the lock entry in src/db/locked.ts is wrong. Refuse to boot.`,
    );
    this.name = 'MigrationLockMismatchError';
  }
}

/**
 * Custom error class — thrown when a `MIGRATION_LOCKS` entry references a
 * filename that has no corresponding payload in the inlined module. This
 * indicates a build-time generation bug (e.g., someone deleted a *.sql
 * file or hand-edited `inlined.ts` to remove an entry without updating
 * `locked.ts`). Acceptance criterion #6 of Task #463.
 */
export class MissingInlinedMigrationError extends Error {
  constructor(public readonly filename: string) {
    super(
      `missing inlined migration payload for ${filename}: the file is referenced by ` +
        `MIGRATION_LOCKS in src/db/locked.ts but is not present in the build-time generated ` +
        `src/db/migrations/inlined.ts. Re-run \`node packages/daemon/build/inline-migrations.mjs\` ` +
        `to regenerate, or restore the missing *.sql file. Refuse to boot.`,
    );
    this.name = 'MissingInlinedMigrationError';
  }
}

/**
 * Resolve the inlined SQL bytes for a bundled migration. Exported so tests
 * can compute expected SHAs without re-deriving the resolution path. Throws
 * `MissingInlinedMigrationError` if the lock references a filename absent
 * from the inlined module.
 */
export function migrationSql(filename: string): string {
  const sql = MIGRATION_SQL[filename];
  if (sql === undefined) {
    throw new MissingInlinedMigrationError(filename);
  }
  return sql;
}

function sha256OfString(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function ensureMigrationsTable(_db: SqliteDatabase): void {
  // Intentional no-op. Migration 001 creates `schema_migrations` itself
  // (see 001_initial.sql); pre-creating it here would collide with that
  // CREATE TABLE on a fresh DB. We leave this helper as a named no-op so
  // any future caller's intent reads correctly. The "is it there?" probe
  // lives in `readAppliedVersions`.
  void _db;
}

interface AppliedRow {
  version: number;
}

function readAppliedVersions(db: SqliteDatabase): Set<number> {
  // The `schema_migrations` table is created by migration 001 itself
  // (see 001_initial.sql) — we deliberately do NOT pre-create it here, so
  // that 001 can run its `CREATE TABLE schema_migrations` without a
  // "table already exists" collision. On a brand-new DB the table is
  // absent; treat that as "no rows applied".
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (exists === undefined) {
    return new Set();
  }
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as AppliedRow[];
  return new Set(rows.map((r) => r.version));
}

/**
 * Apply all unapplied migrations (in lock order) and verify already-applied
 * ones against MIGRATION_LOCKS.
 *
 * Algorithm:
 *   1. Ensure `schema_migrations` exists.
 *   2. Read applied versions.
 *   3. For each lock in order:
 *      a. Resolve inlined SQL (throws MissingInlinedMigrationError if absent).
 *      b. SHA256-verify the inlined bytes match the lock; throw
 *         MigrationLockMismatchError on mismatch.
 *      c. If already-applied: record + continue.
 *      d. If pending: in a single transaction `db.exec(sql)` + INSERT the
 *         schema_migrations row.
 *
 * A note on transactions: better-sqlite3's `db.transaction(fn)` wraps `fn`
 * in BEGIN/COMMIT (and ROLLBACK on throw). We use it so a SQL failure mid-
 * migration leaves `schema_migrations` unchanged — next boot retries from
 * the same starting point.
 */
export function runMigrations(
  db: SqliteDatabase,
  locks: readonly MigrationLock[] = MIGRATION_LOCKS,
): MigrationRunResult {
  ensureMigrationsTable(db);

  const appliedVersions = readAppliedVersions(db);

  const applied: MigrationLock[] = [];
  const alreadyApplied: MigrationLock[] = [];

  // Sort defensively in case a future caller hands us an out-of-order list;
  // the canonical MIGRATION_LOCKS is already version-ordered.
  const orderedLocks = [...locks].sort((a, b) => a.version - b.version);

  for (const lock of orderedLocks) {
    const sql = migrationSql(lock.filename);
    const actualSha = sha256OfString(sql);
    if (actualSha !== lock.sha256) {
      throw new MigrationLockMismatchError(lock.filename, lock.sha256, actualSha);
    }

    if (appliedVersions.has(lock.version)) {
      alreadyApplied.push(lock);
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        lock.version,
        Date.now(),
      );
    });
    apply();
    applied.push(lock);
  }

  return { applied, alreadyApplied };
}
