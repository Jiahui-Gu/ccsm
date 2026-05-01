import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootDb } from '../boot-orchestrator.js';
import type { EnsuredDataDir } from '../ensure-data-dir.js';

// T36 tests: verify the boot orchestrator forks correctly between the
// fresh-install silent path and the existing-db delegate path.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md §8.3

interface MasterRow {
  name: string;
}
interface VersionRow {
  v: string;
}

let tmpDir: string;
let dataDir: string;
let dbPath: string;

function ensured(kind: 'fresh' | 'existing'): EnsuredDataDir {
  return {
    dataRoot: tmpDir,
    dataDir,
    dbPath,
    kind,
    orphansRemoved: 0,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-boot-orch-t36-'));
  dataDir = join(tmpDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  dbPath = join(dataDir, 'ccsm.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootDb — fresh-install silent path (§8.3 step 5)', () => {
  it("returns outcome 'fresh-install' when ensureDataDir reports kind='fresh'", () => {
    const runMigration = vi.fn();
    const result = bootDb({
      ensureDataDir: () => ensured('fresh'),
      runMigration,
    });
    expect(result.outcome).toBe('fresh-install');
    expect(result.ensured.kind).toBe('fresh');
  });

  it("does NOT invoke runMigration on the fresh path", () => {
    const runMigration = vi.fn();
    bootDb({
      ensureDataDir: () => ensured('fresh'),
      runMigration,
    });
    // The single load-bearing assertion: silent path skips the runner
    // entirely so no `migration.*` events can fire.
    expect(runMigration).not.toHaveBeenCalled();
  });

  it("invokes applyFreshSchema with the canonical db path", () => {
    const applyFreshSchema = vi.fn();
    bootDb({
      ensureDataDir: () => ensured('fresh'),
      applyFreshSchema,
      runMigration: vi.fn(),
    });
    expect(applyFreshSchema).toHaveBeenCalledTimes(1);
    expect(applyFreshSchema).toHaveBeenCalledWith(dbPath);
  });

  it("creates a real v0.3 db file (default applyFreshSchema, real sqlite)", () => {
    bootDb({
      ensureDataDir: () => ensured('fresh'),
      runMigration: vi.fn(),
      // default applyFreshSchema → opens better-sqlite3, exec()s v0.3.sql
    });
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as MasterRow[];
      const names = new Set(tables.map((t) => t.name));
      // Spot-check: every v0.3.sql table is present.
      expect(names.has('schema_version')).toBe(true);
      expect(names.has('sessions')).toBe(true);
      expect(names.has('messages')).toBe(true);
      expect(names.has('agents')).toBe(true);
      expect(names.has('jobs')).toBe(true);
      expect(names.has('app_state')).toBe(true);

      const ver = db.prepare('SELECT v FROM schema_version').get() as VersionRow;
      expect(ver.v).toBe('0.3');
    } finally {
      db.close();
    }
  });

  it("returns the unmodified EnsuredDataDir from the producer", () => {
    const e: EnsuredDataDir = {
      dataRoot: tmpDir,
      dataDir,
      dbPath,
      kind: 'fresh',
      orphansRemoved: 3,
    };
    const result = bootDb({
      ensureDataDir: () => e,
      applyFreshSchema: vi.fn(),
      runMigration: vi.fn(),
    });
    expect(result.ensured).toBe(e);
    expect(result.ensured.orphansRemoved).toBe(3);
  });
});

describe('bootDb — existing-db delegate path (§8.3 step 3)', () => {
  it("returns outcome 'existing' when ensureDataDir reports kind='existing'", () => {
    const result = bootDb({
      ensureDataDir: () => ensured('existing'),
      runMigration: vi.fn(),
    });
    expect(result.outcome).toBe('existing');
  });

  it("invokes runMigration with the canonical db path", () => {
    const runMigration = vi.fn();
    bootDb({
      ensureDataDir: () => ensured('existing'),
      runMigration,
    });
    expect(runMigration).toHaveBeenCalledTimes(1);
    expect(runMigration).toHaveBeenCalledWith(dbPath);
  });

  it("does NOT invoke applyFreshSchema on the existing path", () => {
    const applyFreshSchema = vi.fn();
    bootDb({
      ensureDataDir: () => ensured('existing'),
      runMigration: vi.fn(),
      applyFreshSchema,
    });
    expect(applyFreshSchema).not.toHaveBeenCalled();
  });

  it("with a real pre-existing v0.3 db, the default runner is a no-op (idempotent)", () => {
    // Seed a real v0.3-shaped db at dbPath, then call bootDb with the
    // default runMigration. T29's `isAlreadyV03` guard MUST short-circuit
    // so no DDL re-runs and no events fire.
    {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE schema_version (v TEXT PRIMARY KEY);
        INSERT INTO schema_version (v) VALUES ('0.3');
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
      `);
      db.close();
    }
    const result = bootDb({
      ensureDataDir: () => ensured('existing'),
      // default runMigration → migrateV02ToV03 (T29). Should detect
      // already-v0.3 and return without touching the file.
    });
    expect(result.outcome).toBe('existing');

    // Re-open and confirm the seeded schema is intact (no ALTER, no DROP).
    const db = new Database(dbPath, { readonly: true });
    try {
      const ver = db.prepare('SELECT v FROM schema_version').get() as VersionRow;
      expect(ver.v).toBe('0.3');
      const sessionsCols = db
        .prepare("PRAGMA table_info('sessions')")
        .all() as Array<{ name: string }>;
      // The seed had only `id`; if T29 ran it would have added all
      // v0.3.sql columns. Idempotency check: still just `id`.
      expect(sessionsCols.map((c) => c.name)).toEqual(['id']);
    } finally {
      db.close();
    }
  });

  it("with a real pre-existing v0.2 db, the default runner DOES migrate", () => {
    // Inverse check: if a v0.2-shaped db sits at the v0.3 target path
    // (rare — would require manual file copy since v0.2 wrote elsewhere),
    // the existing-path delegate calls T29 which migrates in place.
    {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.pragma('user_version = 1');
      db.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').run(
        'closeAction',
        'tray',
        Date.now(),
      );
      db.close();
    }
    const result = bootDb({
      ensureDataDir: () => ensured('existing'),
    });
    expect(result.outcome).toBe('existing');

    const db = new Database(dbPath, { readonly: true });
    try {
      const ver = db.prepare('SELECT v FROM schema_version').get() as VersionRow;
      expect(ver.v).toBe('0.3');
      // After migration, app_state is the singleton with typed columns.
      const cols = db.prepare("PRAGMA table_info('app_state')").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      expect(colNames.has('id')).toBe(true);
      expect(colNames.has('close_action')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('bootDb — defaults wiring', () => {
  it('uses defaultEnsureDataDir when no override is supplied (smoke)', () => {
    // Without an override, ensureDataDir reads real env + writes to
    // %LOCALAPPDATA%\ccsm. We don't want to pollute the host on test
    // run, so we override ensureDataDir but leave applyFreshSchema and
    // runMigration as defaults — this asserts the dep-injection
    // surface compiles + accepts partial overrides.
    const result = bootDb({
      ensureDataDir: () => ensured('fresh'),
    });
    expect(result.outcome).toBe('fresh-install');
    expect(existsSync(dbPath)).toBe(true);
  });
});
