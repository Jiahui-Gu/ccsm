import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateV02ToV03 } from '../migrate-v02-to-v03.js';

// T29 tests: verify the v0.2 → v0.3 schema migration runner.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md §8.5
// Schema: daemon/src/db/schema/v0.3.sql (T28)

interface MasterRow {
  name: string;
}
interface AppStateRow {
  id: number;
  close_to_tray_shown_at: number | null;
  close_action: string | null;
  notify_enabled: number | null;
  crash_reporting_opt_out: number | null;
  user_cwds: string | null;
  updated_at: number;
}
interface VersionRow {
  v: string;
}

let tmpDir: string;
let dbPath: string;

function seedV02(rows: Record<string, string>): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.pragma('user_version = 1');
  const stmt = db.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)');
  const now = Date.now();
  for (const [k, v] of Object.entries(rows)) {
    stmt.run(k, v, now);
  }
  db.close();
}

function openRead(): Database.Database {
  return new Database(dbPath, { readonly: true });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-migrate-t29-'));
  dbPath = join(tmpDir, 'ccsm.db');
});

afterEach(() => {
  // WAL/SHM sidecars may exist; force-rm the whole dir.
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateV02ToV03', () => {
  it('stamps schema_version=0.3 after migration', () => {
    seedV02({});
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT v FROM schema_version').get() as VersionRow | undefined;
    expect(row?.v).toBe('0.3');
    db.close();
  });

  it('creates all v0.3 tables', () => {
    seedV02({});
    migrateV02ToV03(dbPath);
    const db = openRead();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as MasterRow[];
    const names = tables.map((r) => r.name);
    for (const required of ['agents', 'app_state', 'jobs', 'messages', 'schema_version', 'sessions']) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('drops the legacy v0.2 KV app_state table', () => {
    seedV02({ closeAction: 'tray' });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const legacy = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state_v02_legacy'")
      .all() as MasterRow[];
    expect(legacy).toHaveLength(0);
    // The new app_state should NOT have the legacy `key`/`value` columns.
    const cols = db.prepare("PRAGMA table_info('app_state')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).not.toContain('key');
    expect(colNames).not.toContain('value');
    db.close();
  });

  it('translates closeAction KV → close_action column', () => {
    seedV02({ closeAction: 'quit' });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.close_action).toBe('quit');
    db.close();
  });

  it('translates notifyEnabled KV → integer 0/1', () => {
    seedV02({ notifyEnabled: 'false' });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.notify_enabled).toBe(0);
    db.close();
  });

  it('treats notifyEnabled=true and "1" as 1', () => {
    seedV02({ notifyEnabled: '1' });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.notify_enabled).toBe(1);
    db.close();
  });

  it('translates crashReportingOptOut KV → integer 0/1', () => {
    seedV02({ crashReportingOptOut: 'true' });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.crash_reporting_opt_out).toBe(1);
    db.close();
  });

  it('translates userCwds KV → user_cwds column (passthrough JSON)', () => {
    const cwdsJson = JSON.stringify(['C:\\repo', 'C:\\other']);
    seedV02({ userCwds: cwdsJson });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.user_cwds).toBe(cwdsJson);
    db.close();
  });

  it('translates all five canonical v0.2 KV keys in one pass', () => {
    seedV02({
      closeAction: 'tray',
      notifyEnabled: 'true',
      crashReportingOptOut: 'false',
      userCwds: '["~/projects"]',
      closeToTrayShownAt: '1714521600000',
    });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.close_action).toBe('tray');
    expect(row.notify_enabled).toBe(1);
    expect(row.crash_reporting_opt_out).toBe(0);
    expect(row.user_cwds).toBe('["~/projects"]');
    expect(row.close_to_tray_shown_at).toBe(1714521600000);
    db.close();
  });

  it('leaves columns NULL when KV key is missing', () => {
    seedV02({ closeAction: 'ask' });
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.close_action).toBe('ask');
    expect(row.notify_enabled).toBeNull();
    expect(row.crash_reporting_opt_out).toBeNull();
    expect(row.user_cwds).toBeNull();
    expect(row.close_to_tray_shown_at).toBeNull();
    db.close();
  });

  it('drops unknown v0.2 KV keys silently (forward-compat)', () => {
    // claudeBinPath was a removed v0.2 key (electron/db.ts:215). Ensure
    // the migration doesn't choke on it.
    seedV02({ claudeBinPath: '/usr/local/bin/claude', closeAction: 'tray' });
    expect(() => migrateV02ToV03(dbPath)).not.toThrow();
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.close_action).toBe('tray');
    db.close();
  });

  it('handles empty v0.2 app_state (fresh-install upgrade)', () => {
    seedV02({});
    migrateV02ToV03(dbPath);
    const db = openRead();
    const row = db.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.id).toBe(1);
    expect(row.close_action).toBeNull();
    db.close();
  });

  it('is idempotent — running twice is a no-op on the second call', () => {
    seedV02({ closeAction: 'quit' });
    migrateV02ToV03(dbPath);
    const db1 = openRead();
    const firstUpdatedAt = (db1.prepare('SELECT updated_at FROM app_state WHERE id = 1').get() as AppStateRow).updated_at;
    db1.close();

    // Spin until the clock advances at least 1ms so a second write would
    // be observable.
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }

    migrateV02ToV03(dbPath);
    const db2 = openRead();
    const row = db2.prepare('SELECT * FROM app_state WHERE id = 1').get() as AppStateRow;
    expect(row.close_action).toBe('quit');
    // No second write — updated_at unchanged proves the early-return fired.
    expect(row.updated_at).toBe(firstUpdatedAt);
    db2.close();
  });

  it('clears PRAGMA user_version (v0.2 stamp = 1)', () => {
    seedV02({});
    migrateV02ToV03(dbPath);
    const db = openRead();
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    db.close();
  });

  it('rolls back on synthetic failure mid-transaction', () => {
    seedV02({ closeAction: 'tray', notifyEnabled: 'true' });

    // Snapshot the pre-migration table list — must be unchanged after
    // rollback.
    const pre = new Database(dbPath);
    const preTables = pre
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as MasterRow[];
    pre.close();

    // Inject a failure by spying on Database.prototype.exec to throw on
    // the first DDL exec call (after pragmas split out of the transaction
    // — i.e. once we're inside the `runMigration` body).
    const originalExec = Database.prototype.exec;
    let calls = 0;
    const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
      calls += 1;
      // First exec inside the txn is the legacy-table rename. Throw on
      // call #2 (the v0.3 schema DDL apply) so the rename has already
      // happened — gives the rollback something real to undo.
      if (calls === 2) throw new Error('synthetic failure');
      return originalExec.call(this, sql) as Database.Database;
    });

    expect(() => migrateV02ToV03(dbPath)).toThrow(/synthetic failure/);
    spy.mockRestore();

    // Verify rollback: post-state must match pre-state.
    const post = new Database(dbPath, { readonly: true });
    const postTables = post
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as MasterRow[];
    expect(postTables.map((t) => t.name)).toEqual(preTables.map((t) => t.name));
    // schema_version must NOT exist (would be a partial-commit symptom).
    expect(postTables.find((t) => t.name === 'schema_version')).toBeUndefined();
    // The legacy KV table is still there with original rows.
    const rows = post.prepare('SELECT key, value FROM app_state ORDER BY key').all() as Array<{ key: string; value: string }>;
    expect(rows).toEqual([
      { key: 'closeAction', value: 'tray' },
      { key: 'notifyEnabled', value: 'true' },
    ]);
    post.close();
  });

  it('throws on a corrupt / non-sqlite file', () => {
    // Write a non-SQLite file at dbPath.
    writeFileSync(dbPath, 'this is not a sqlite database');
    expect(() => migrateV02ToV03(dbPath)).toThrow();
    // sidecar cleanup not our job (orchestrator owns it per frag-8 §8.5).
    expect(existsSync(dbPath)).toBe(true);
  });

  it('creates v0.3 indices', () => {
    seedV02({});
    migrateV02ToV03(dbPath);
    const db = openRead();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as MasterRow[];
    const names = idx.map((r) => r.name);
    expect(names).toContain('idx_messages_session_created');
    expect(names).toContain('idx_jobs_status_scheduled');
    expect(names).toContain('idx_sessions_state');
    db.close();
  });
});
