// packages/daemon/src/db/migrations/runner.ts
//
// Migration runner. Spec ch07 §4 (forward-only migrations + immutability lock).
//
// Responsibilities:
//   1. Ensure `schema_migrations` table exists (bootstrap-safe).
//   2. SELF-CHECK: for every row already in `schema_migrations`, verify the
//      bundled file's SHA256 matches the entry in MIGRATION_LOCKS. Mismatch
//      = abort startup with an explicit error (ch07 §4 immutability lock —
//      "v0.3 migration files are immutable after v0.3 ships"). The release
//      body of v0.3.0 is the source of truth (cross-checked in CI by
//      tools/check-migration-locks.sh); this self-check guards against a
//      tampered or corrupted bundled file post-install.
//   3. Determine pending migrations (lock entries whose `version` exceeds
//      `MAX(schema_migrations.version)`). Apply them in order, each in a
//      transaction that wraps the SQL exec + `INSERT INTO schema_migrations`
//      so a partial apply rolls back atomically.
//
// Bundled-file resolution: migrations live alongside this file under
// `packages/daemon/src/db/migrations/`. The runner reads them via
// `import.meta.url` so a SEA-bundled binary that ships them as snapshot
// resources still resolves correctly relative to the compiled source.
//
// Out of scope here:
//   - Driver / PRAGMAs (T5.1, packages/daemon/src/db/sqlite.ts).
//   - WAL discipline / checkpoints (T5.6).
//   - v0.2 → v0.3 user-data migration (one-shot installer-driven; ch07 §4.5).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SqliteDatabase } from '../sqlite.js';

import { MIGRATION_LOCKS, type MigrationLock } from '../locked.js';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

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
 * Custom error class — thrown when the SHA256 of a bundled migration file
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
 * Resolve the absolute path of a bundled migration file. Exported for tests
 * (so they can build expected SHAs without re-deriving the directory).
 */
export function migrationFilePath(filename: string): string {
  return join(MIGRATIONS_DIR, filename);
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
 *      a. If applied: SHA256-verify the bundled file matches the lock; throw
 *         MigrationLockMismatchError on mismatch.
 *      b. If unapplied: read the file, SHA256-verify it matches the lock
 *         (so we never APPLY a tampered file either), then in a single
 *         transaction `db.exec(sql)` + INSERT the schema_migrations row.
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
    const path = migrationFilePath(lock.filename);
    const actualSha = sha256OfFile(path);
    if (actualSha !== lock.sha256) {
      throw new MigrationLockMismatchError(lock.filename, lock.sha256, actualSha);
    }

    if (appliedVersions.has(lock.version)) {
      alreadyApplied.push(lock);
      continue;
    }

    const sql = readFileSync(path, 'utf8');
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
