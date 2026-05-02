// Tests for daemon/src/db/additive-migrations.ts and the seven shipped
// migration files under daemon/src/db/migrations/.
//
// Coverage:
//   1. Round-trip: fresh in-memory db + v0.3 schema + every shipped
//      migration applied; assert all 7 expected schema objects exist
//      and the ledger is fully populated.
//   2. No data loss: pre-migration rows in `sessions` survive
//      001-session-extensions; new columns are NULL on legacy rows.
//   3. Idempotency: second run is a no-op (zero applied, all skipped).
//   4. Per-file: each migration is additive (no DROP / RENAME / etc
//      detectable via sqlite_master diff before/after).
//   5. Checksum tamper detection: edited migration text is rejected
//      with the canonical error message.
//   6. Ordering: filename byte-sort = apply order (NN-prefix convention).

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAdditiveMigrations } from '../additive-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'schema', 'v0.3.sql');
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface MasterRow {
  type: string;
  name: string;
}
interface ColRow {
  name: string;
  notnull: number;
  dflt_value: string | null;
}
interface AppliedRow {
  filename: string;
  sha256: string;
}

function freshDbWithSchema(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function listObjects(db: Database.Database): MasterRow[] {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as MasterRow[];
}

describe('additive migrations — runner', () => {
  it('applies every shipped .sql file once and only once', () => {
    const db = freshDbWithSchema();

    const first = runAdditiveMigrations(db);
    expect(first.applied.length).toBe(7);
    expect(first.skipped).toEqual([]);
    // Filename order is the apply order; assert lexicographic 001..007.
    expect(first.applied).toEqual([
      '001-session-extensions.sql',
      '002-session-titles.sql',
      '003-pending-session-titles.sql',
      '004-recent-cwds.sql',
      '005-pty-session-state.sql',
      '006-session-events.sql',
      '007-notify-markers.sql',
    ]);

    const second = runAdditiveMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(7);

    db.close();
  });

  it('creates the applied_migrations ledger and records every file with its sha256', () => {
    const db = freshDbWithSchema();
    runAdditiveMigrations(db);

    const ledger = db
      .prepare('SELECT filename, sha256 FROM applied_migrations ORDER BY filename')
      .all() as AppliedRow[];
    expect(ledger.length).toBe(7);
    for (const row of ledger) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    db.close();
  });

  it('throws on checksum mismatch (tamper detection)', () => {
    const db = freshDbWithSchema();
    const tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-mig-tamper-'));
    // Seed the tmp dir with a single benign migration, apply it, then
    // edit the file on disk and re-run — the runner must throw rather
    // than silently re-exec or skip.
    const migrationFile = join(tmpDir, '001-foo.sql');
    writeFileSync(migrationFile, 'CREATE TABLE foo (id INTEGER PRIMARY KEY);\n');
    runAdditiveMigrations(db, { migrationsDir: tmpDir });

    writeFileSync(migrationFile, 'CREATE TABLE foo (id INTEGER PRIMARY KEY, x TEXT);\n');
    expect(() => runAdditiveMigrations(db, { migrationsDir: tmpDir })).toThrow(
      /sha256 mismatch for 001-foo\.sql/,
    );

    db.close();
  });

  it('treats a missing migrations directory as zero work', () => {
    const db = freshDbWithSchema();
    const tmpDir = join(tmpdir(), `ccsm-mig-missing-${Date.now()}-${Math.random()}`);
    const result = runAdditiveMigrations(db, { migrationsDir: tmpDir });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    db.close();
  });

  it('applies new files added after a prior run', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    const tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-mig-grow-'));
    writeFileSync(join(tmpDir, '001-a.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY);\n');
    const r1 = runAdditiveMigrations(db, { migrationsDir: tmpDir });
    expect(r1.applied).toEqual(['001-a.sql']);

    writeFileSync(join(tmpDir, '002-b.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);\n');
    const r2 = runAdditiveMigrations(db, { migrationsDir: tmpDir });
    expect(r2.applied).toEqual(['002-b.sql']);
    expect(r2.skipped).toEqual(['001-a.sql']);
    db.close();
  });

  it('rolls back the SQL exec when a migration throws (no orphan ledger row)', () => {
    const db = freshDbWithSchema();
    const tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-mig-rollback-'));
    // A statement that parses but fails at exec time (unique-on-already-existing).
    writeFileSync(
      join(tmpDir, '001-bad.sql'),
      'CREATE TABLE sessions (id INTEGER PRIMARY KEY);\n',
    );
    expect(() => runAdditiveMigrations(db, { migrationsDir: tmpDir })).toThrow();
    const ledger = db.prepare('SELECT * FROM applied_migrations').all() as AppliedRow[];
    expect(ledger).toEqual([]);
    db.close();
  });
});

describe('additive migrations — round-trip schema upgrade', () => {
  it('every shipped migration leaves an additive footprint (object count never decreases)', () => {
    const db = freshDbWithSchema();
    const baselineObjects = listObjects(db);
    runAdditiveMigrations(db);
    const afterObjects = listObjects(db);

    // Every baseline object must still be present (no DROP).
    for (const obj of baselineObjects) {
      const stillThere = afterObjects.find((o) => o.type === obj.type && o.name === obj.name);
      expect(stillThere, `${obj.type} ${obj.name} disappeared after migrations`).toBeTruthy();
    }
    // Count strictly grew (we added tables AND indexes AND a ledger).
    expect(afterObjects.length).toBeGreaterThan(baselineObjects.length);
    db.close();
  });

  it('001-session-extensions adds nullable columns + the latest_seq DEFAULT-0 column without losing rows', () => {
    const db = freshDbWithSchema();
    // Seed a v0.3-baseline-shaped session row BEFORE the additive
    // migration runs.
    db.prepare(
      "INSERT INTO sessions (id, repo, title, state) VALUES ('sess-1', 'r', 't', 'running')",
    ).run();

    runAdditiveMigrations(db);

    const cols = db.prepare("PRAGMA table_info('sessions')").all() as ColRow[];
    const colNames = cols.map((c) => c.name);
    for (const required of [
      'cwd',
      'spawn_cwd',
      'latest_seq',
      'boot_nonce',
      'spawned_at_ms',
      'requires_action_at_ms',
    ]) {
      expect(colNames).toContain(required);
    }

    // Nullability contract: every new column is nullable (notnull=0)
    // EXCEPT latest_seq which is NOT NULL DEFAULT 0 (allowed by the
    // schema-additive lint because of the DEFAULT).
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('cwd')?.notnull).toBe(0);
    expect(byName.get('spawn_cwd')?.notnull).toBe(0);
    expect(byName.get('boot_nonce')?.notnull).toBe(0);
    expect(byName.get('spawned_at_ms')?.notnull).toBe(0);
    expect(byName.get('requires_action_at_ms')?.notnull).toBe(0);
    expect(byName.get('latest_seq')?.notnull).toBe(1);

    // Pre-existing row still readable; new columns NULL / DEFAULT.
    const row = db
      .prepare(
        'SELECT id, cwd, spawn_cwd, latest_seq, boot_nonce, spawned_at_ms, requires_action_at_ms FROM sessions WHERE id = ?',
      )
      .get('sess-1') as Record<string, unknown>;
    expect(row.id).toBe('sess-1');
    expect(row.cwd).toBeNull();
    expect(row.spawn_cwd).toBeNull();
    expect(row.boot_nonce).toBeNull();
    expect(row.spawned_at_ms).toBeNull();
    expect(row.requires_action_at_ms).toBeNull();
    expect(row.latest_seq).toBe(0);

    db.close();
  });

  it('002-session-titles creates the table + project index', () => {
    const db = freshDbWithSchema();
    runAdditiveMigrations(db);
    const cols = db.prepare("PRAGMA table_info('session_titles')").all() as ColRow[];
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['project_path', 'session_id', 'title', 'updated_at_ms'].sort(),
    );
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_titles_project'")
      .all();
    expect(idx.length).toBe(1);
    db.close();
  });

  it('003-pending-session-titles creates queue with idempotency_key PK', () => {
    const db = freshDbWithSchema();
    runAdditiveMigrations(db);
    const cols = db.prepare("PRAGMA table_info('pending_session_titles')").all() as Array<
      ColRow & { pk: number }
    >;
    const pk = cols.find((c) => c.name === 'idempotency_key');
    expect(pk?.pk).toBe(1);
    // Round-trip insert: same key inserted twice ⇒ second throws.
    db.prepare(
      "INSERT INTO pending_session_titles (idempotency_key, session_id, raw_message) VALUES ('k1', 's1', 'hello')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO pending_session_titles (idempotency_key, session_id, raw_message) VALUES ('k1', 's1', 'world')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('004-recent-cwds dedupes by cwd PK (LRU upsert pattern)', () => {
    const db = freshDbWithSchema();
    runAdditiveMigrations(db);
    db.prepare("INSERT INTO recent_cwds (cwd) VALUES ('/foo')").run();
    expect(() => db.prepare("INSERT INTO recent_cwds (cwd) VALUES ('/foo')").run()).toThrow();
    // The natural LRU upsert must work via INSERT ... ON CONFLICT.
    db.prepare(
      'INSERT INTO recent_cwds (cwd, last_used_at_ms, use_count) VALUES (?, ?, 1) ' +
        'ON CONFLICT(cwd) DO UPDATE SET last_used_at_ms = excluded.last_used_at_ms, use_count = use_count + 1',
    ).run('/foo', 999);
    const row = db.prepare('SELECT use_count FROM recent_cwds WHERE cwd = ?').get('/foo') as {
      use_count: number;
    };
    expect(row.use_count).toBe(2);
    db.close();
  });

  it('005-pty-session-state cascades on session deletion', () => {
    const db = freshDbWithSchema();
    db.pragma('foreign_keys = ON');
    runAdditiveMigrations(db);
    db.prepare(
      "INSERT INTO sessions (id, repo, title, state) VALUES ('s1', 'r', 't', 'running')",
    ).run();
    db.prepare("INSERT INTO pty_session_state (session_id, latest_seq) VALUES ('s1', 42)").run();
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    const row = db.prepare("SELECT * FROM pty_session_state WHERE session_id = 's1'").get();
    expect(row).toBeUndefined();
    db.close();
  });

  it('006-session-events enforces (session_id, seq) uniqueness', () => {
    const db = freshDbWithSchema();
    runAdditiveMigrations(db);
    db.prepare(
      "INSERT INTO session_events (session_id, seq, kind, payload) VALUES ('s1', 1, 'k', 'p')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO session_events (session_id, seq, kind, payload) VALUES ('s1', 1, 'k', 'p2')",
        )
        .run(),
    ).toThrow();
    // Different session same seq is fine.
    db.prepare(
      "INSERT INTO session_events (session_id, seq, kind, payload) VALUES ('s2', 1, 'k', 'p')",
    ).run();
    db.close();
  });

  it('007-notify-markers enforces idempotency_key UNIQUE', () => {
    const db = freshDbWithSchema();
    runAdditiveMigrations(db);
    db.prepare(
      "INSERT INTO notify_markers (session_id, idempotency_key, kind) VALUES ('s1', 'i1', 'flash')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO notify_markers (session_id, idempotency_key, kind) VALUES ('s2', 'i1', 'flash')",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe('additive migrations — shipped files match the lint contract', () => {
  it('every shipped .sql file is named NNN-slug.sql so byte-sort matches intent', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /\.sql$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).toMatch(/^\d{3}-[a-z0-9-]+\.sql$/);
    }
  });

  it('round-trip on an empty in-memory db produces identical sqlite_master snapshots from two runs', () => {
    const dbA = freshDbWithSchema();
    const dbB = freshDbWithSchema();
    runAdditiveMigrations(dbA);
    runAdditiveMigrations(dbB);
    const a = listObjects(dbA);
    const b = listObjects(dbB);
    expect(a).toEqual(b);
    dbA.close();
    dbB.close();
  });
});

// Sanity: the test fixture directory machinery is plumbed correctly so
// callers can actually point the runner at an alternate dir during boot
// tests (e.g. in tests/scripts/lint-schema-additive.test.ts patterns).
describe('additive migrations — opts.migrationsDir override is honored', () => {
  it('runs files from the supplied dir instead of the shipped one', () => {
    const db = new Database(':memory:');
    const tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-mig-opts-'));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, '001-only.sql'), 'CREATE TABLE only_me (id INTEGER PRIMARY KEY);\n');
    const result = runAdditiveMigrations(db, { migrationsDir: tmpDir });
    expect(result.applied).toEqual(['001-only.sql']);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as MasterRow[];
    expect(tables.map((t) => t.name)).toContain('only_me');
    // The shipped session_titles table from 002 must NOT appear, proving
    // the default dir was bypassed.
    expect(tables.map((t) => t.name)).not.toContain('session_titles');
    db.close();
  });
});
