// packages/daemon/src/db/migrations/__tests__/runner.spec.ts
//
// Unit tests for the migration runner (T5.4 / Task #56). Spec ch07 §4.
//
// Coverage:
//   - empty DB → applies every lock in MIGRATION_LOCKS, schema_migrations
//     ends with one row per applied version
//   - already-applied DB → no rows applied, alreadyApplied list populated
//   - partial DB (existing rows + a new pending lock) → only the unapplied
//     row gets inserted; existing rows are NOT re-applied
//   - SHA256 mismatch on an already-applied row → throws
//     MigrationLockMismatchError, schema_migrations untouched
//   - SHA256 mismatch on a pending row → throws BEFORE any SQL exec runs

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATION_LOCKS, type MigrationLock } from '../../locked.js';
import { openDatabase, type SqliteDatabase } from '../../sqlite.js';

import {
  MigrationLockMismatchError,
  migrationFilePath,
  runMigrations,
} from '../runner.js';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('runMigrations (T5.4 — ch07 §4)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: SqliteDatabase | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-migration-runner-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        // best-effort
      }
      db = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies every lock against an empty database', () => {
    db = openDatabase(dbPath);
    const result = runMigrations(db);

    expect(result.applied.map((m) => m.version)).toEqual(MIGRATION_LOCKS.map((m) => m.version));
    expect(result.alreadyApplied).toEqual([]);

    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows.map((r) => r.version)).toEqual(MIGRATION_LOCKS.map((m) => m.version));
  });

  it('is idempotent on a fully-applied database', () => {
    db = openDatabase(dbPath);
    runMigrations(db);

    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.map((m) => m.version)).toEqual(
      MIGRATION_LOCKS.map((m) => m.version),
    );
  });

  it('applies only the pending remainder when partially applied', () => {
    // Drop a synthetic 999_*.sql into the real migrations dir for the
    // duration of this test (and remove it in finally). The runner's file
    // resolver is fixed to that dir, so this is the simplest path to
    // exercise multi-lock partial-apply semantics without a fixture
    // injection seam in the runner. Using version 999 avoids any clash
    // with future real migrations.
    const realDir = dirname(migrationFilePath('001_initial.sql'));
    const synthSql = 'CREATE TABLE synth_partial (k INTEGER PRIMARY KEY);\n';
    const synthPath = join(realDir, '999_synth_partial.sql');
    const synthSha = createHash('sha256').update(synthSql).digest('hex');
    writeFileSync(synthPath, synthSql);

    try {
      db = openDatabase(dbPath);
      // First call: empty DB, real locks only — applies the real 001.
      const first = runMigrations(db);
      expect(first.applied.length).toBe(MIGRATION_LOCKS.length);

      // Second call: extended lock list — runner skips 001 (alreadyApplied)
      // and applies the synthetic 999.
      const customLocks: MigrationLock[] = [
        ...MIGRATION_LOCKS,
        { version: 999, filename: '999_synth_partial.sql', sha256: synthSha },
      ];
      const partial = runMigrations(db, customLocks);
      expect(partial.alreadyApplied.map((m) => m.version)).toEqual(
        MIGRATION_LOCKS.map((m) => m.version),
      );
      expect(partial.applied.map((m) => m.version)).toEqual([999]);

      const versions = (
        db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
          version: number;
        }[]
      ).map((r) => r.version);
      expect(versions).toEqual([...MIGRATION_LOCKS.map((m) => m.version), 999]);

      // Sanity: the synth table exists.
      const tableRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synth_partial'")
        .all() as { name: string }[];
      expect(tableRows.map((r) => r.name)).toEqual(['synth_partial']);
    } finally {
      rmSync(synthPath, { force: true });
    }
  });

  it('aborts when an already-applied migration on disk has a mismatched SHA256', () => {
    db = openDatabase(dbPath);
    runMigrations(db);

    // Swap the lock list to claim a different SHA for the existing 001 row.
    const tampered: MigrationLock[] = MIGRATION_LOCKS.map((m) => ({
      ...m,
      sha256: 'deadbeef'.repeat(8), // 64-char fake hex
    }));

    expect(() => runMigrations(db!, tampered)).toThrow(MigrationLockMismatchError);

    // schema_migrations rows untouched (no extra inserts, no deletions).
    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(versions).toEqual(MIGRATION_LOCKS.map((m) => m.version));
  });

  it('aborts BEFORE applying when a pending migration has a mismatched SHA256', () => {
    db = openDatabase(dbPath);

    const tampered: MigrationLock[] = MIGRATION_LOCKS.map((m) => ({
      ...m,
      sha256: '0'.repeat(64),
    }));

    expect(() => runMigrations(db!, tampered)).toThrow(MigrationLockMismatchError);

    // schema_migrations is created by migration 001 itself, so after a
    // pending-mismatch abort on a fresh DB the table does not exist yet.
    const tableExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    expect(tableExists).toBeUndefined();
  });

  it('error carries filename + expected/actual SHA for log-scrape friendliness', () => {
    db = openDatabase(dbPath);
    const tampered: MigrationLock[] = [
      { version: 1, filename: '001_initial.sql', sha256: 'a'.repeat(64) },
    ];
    try {
      runMigrations(db, tampered);
      expect.unreachable('runMigrations should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationLockMismatchError);
      const e = err as MigrationLockMismatchError;
      expect(e.filename).toBe('001_initial.sql');
      expect(e.expectedSha256).toBe('a'.repeat(64));
      expect(e.actualSha256).toBe(sha256(migrationFilePath('001_initial.sql')));
    }
  });
});
