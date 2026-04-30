import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// T28 smoke: load the canonical v0.3 schema into an in-memory db and
// assert the contracts T29 (migration runner) and T36 (fresh-install)
// will rely on. Pure structural checks — no row-shape assertions, those
// belong with the consumers.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'v0.3.sql');

interface MasterRow {
  name: string;
}
interface ColRow {
  name: string;
}
interface VerRow {
  v: string;
}

function openWithSchema(): Database.Database {
  const db = new Database(':memory:');
  // PRAGMA journal_mode=WAL is a no-op on :memory: but exec'ing the
  // file shouldn't throw — proves the statement parses.
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

describe('v0.3 schema', () => {
  it('stamps schema_version row to 0.3', () => {
    const db = openWithSchema();
    const row = db.prepare('SELECT v FROM schema_version').get() as VerRow | undefined;
    expect(row?.v).toBe('0.3');
    db.close();
  });

  it('creates all required tables', () => {
    const db = openWithSchema();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as MasterRow[];
    const names = rows.map((r) => r.name);
    for (const required of [
      'agents',
      'app_state',
      'jobs',
      'messages',
      'schema_version',
      'sessions',
    ]) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('creates required indices', () => {
    const db = openWithSchema();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as MasterRow[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('idx_messages_session_created');
    expect(names).toContain('idx_jobs_status_scheduled');
    db.close();
  });

  it('app_state has all typed prefs columns (frag-6-7 §6.8 lock)', () => {
    const db = openWithSchema();
    const cols = db.prepare("PRAGMA table_info('app_state')").all() as ColRow[];
    const names = cols.map((c) => c.name);
    for (const required of [
      'close_to_tray_shown_at',
      'close_action',
      'notify_enabled',
      'crash_reporting_opt_out',
      'user_cwds',
      'updated_at',
    ]) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('app_state singleton CHECK(id=1) rejects second row', () => {
    const db = openWithSchema();
    expect(() =>
      db.prepare('INSERT INTO app_state (id, updated_at) VALUES (2, 0)').run()
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('sessions.state CHECK rejects unknown state values', () => {
    const db = openWithSchema();
    expect(() =>
      db
        .prepare(
          "INSERT INTO sessions (id, state, created_at, updated_at) VALUES ('s1', 'garbage', 0, 0)"
        )
        .run()
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('sessions.state CHECK accepts all spec-locked enum values', () => {
    const db = openWithSchema();
    const values = ['running', 'paused', 'exited', 'shutting_down', 'crashed'];
    for (const v of values) {
      expect(() =>
        db
          .prepare(
            "INSERT INTO sessions (id, state, created_at, updated_at) VALUES (?, ?, 0, 0)"
          )
          .run(`s-${v}`, v)
      ).not.toThrow();
    }
    db.close();
  });

  it('messages.role CHECK rejects unknown role', () => {
    const db = openWithSchema();
    db.prepare(
      "INSERT INTO sessions (id, state, created_at, updated_at) VALUES ('s1', 'running', 0, 0)"
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', 's1', 'wizard', '', 0)"
        )
        .run()
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('jobs.status CHECK rejects unknown status', () => {
    const db = openWithSchema();
    expect(() =>
      db
        .prepare(
          "INSERT INTO jobs (id, type, payload, status, scheduled_at) VALUES ('j1', 't', '{}', 'weird', 0)"
        )
        .run()
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('created_at DEFAULT fills ms-epoch when omitted', () => {
    const db = openWithSchema();
    const before = Date.now();
    db.prepare("INSERT INTO sessions (id, state) VALUES ('sX', 'running')").run();
    const after = Date.now();
    const row = db
      .prepare("SELECT created_at, updated_at FROM sessions WHERE id = 'sX'")
      .get() as { created_at: number; updated_at: number };
    // unixepoch('now') is whole-second precision; allow 1s slack each side.
    expect(row.created_at).toBeGreaterThanOrEqual(before - 1000);
    expect(row.created_at).toBeLessThanOrEqual(after + 1000);
    expect(row.updated_at).toBeGreaterThanOrEqual(before - 1000);
    db.close();
  });

  it('sessions has spawn_trace_id, pid, pgid columns', () => {
    const db = openWithSchema();
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as ColRow[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['id', 'state', 'pid', 'pgid', 'spawn_trace_id'])
    );
    db.close();
  });

  it('messages.session_id FK references sessions', () => {
    const db = openWithSchema();
    const fks = db.prepare("PRAGMA foreign_key_list('messages')").all() as Array<{
      table: string;
      from: string;
    }>;
    expect(fks.find((f) => f.from === 'session_id' && f.table === 'sessions')).toBeTruthy();
    db.close();
  });
});
