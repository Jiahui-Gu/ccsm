// Unit tests for `SqliteSnapshotStore` (Task #51 / T4.14).
//
// Drives the read interface against a real in-memory better-sqlite3
// instance (faster than tmp file + cleanup; same query planner /
// `safeIntegers` semantics as production). The migration runner
// applies `001_initial.sql` so the FK constraint on
// `pty_snapshot.session_id` -> `sessions.id` is real.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../db/sqlite.js';
import { runMigrations } from '../../db/migrations/runner.js';
import { SqliteSnapshotStore } from '../snapshot-store.js';

const SESSION_ID = '01J0TESTSESSION0000000001';
const OTHER_SESSION = '01J0TESTSESSION0000000002';
const PRINCIPAL_KEY = 'local-user:1000';

describe('SqliteSnapshotStore', () => {
  let tmpDir: string;
  let db: SqliteDatabase;
  let store: SqliteSnapshotStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-snapshot-store-'));
    db = openDatabase(join(tmpDir, 'test.db'));
    runMigrations(db);
    // Seed principals + sessions so the pty_snapshot/pty_delta FKs hold.
    db.prepare(
      'INSERT INTO principals (id, kind, display_name, first_seen_ms, last_seen_ms) ' +
        'VALUES (?, ?, ?, ?, ?)',
    ).run(PRINCIPAL_KEY, 'local-user', 'tester', 1, 1);
    const insertSession = db.prepare(
      'INSERT INTO sessions (id, owner_id, state, cwd, env_json, claude_args_json, ' +
        'geometry_cols, geometry_rows, created_ms, last_active_ms) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertSession.run(SESSION_ID, PRINCIPAL_KEY, 1, '/tmp', '{}', '[]', 80, 24, 1, 1);
    insertSession.run(OTHER_SESSION, PRINCIPAL_KEY, 1, '/tmp', '{}', '[]', 80, 24, 1, 1);
    store = new SqliteSnapshotStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getLatestSnapshot', () => {
    it('returns null when no snapshot rows exist', () => {
      expect(store.getLatestSnapshot(SESSION_ID)).toBeNull();
    });

    it('returns the row mapped to RestoreSnapshotRow shape', () => {
      const payload = new Uint8Array([0xc5, 0x53, 0x53, 0x31]);
      db.prepare(
        'INSERT INTO pty_snapshot ' +
          '(session_id, base_seq, schema_version, geometry_cols, geometry_rows, payload, created_ms) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(SESSION_ID, 100, 1, 120, 40, Buffer.from(payload), 1_700_000_000_000);

      const row = store.getLatestSnapshot(SESSION_ID);
      expect(row).not.toBeNull();
      expect(row!.baseSeq).toBe(100n);
      expect(row!.schemaVersion).toBe(1);
      expect(row!.geometry).toEqual({ cols: 120, rows: 40 });
      // better-sqlite3 returns BLOBs as Node Buffer (which IS a
      // Uint8Array); compare by content rather than identity.
      expect(Array.from(row!.payload)).toEqual([0xc5, 0x53, 0x53, 0x31]);
      expect(row!.createdMs).toBe(1_700_000_000_000);
    });

    it('returns the row with the highest base_seq (multi-snapshot history)', () => {
      const insert = db.prepare(
        'INSERT INTO pty_snapshot ' +
          '(session_id, base_seq, schema_version, geometry_cols, geometry_rows, payload, created_ms) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      insert.run(SESSION_ID, 1, 1, 80, 24, Buffer.from([0x01]), 1_000);
      insert.run(SESSION_ID, 50, 1, 80, 24, Buffer.from([0x32]), 2_000);
      insert.run(SESSION_ID, 25, 1, 80, 24, Buffer.from([0x19]), 3_000);

      const row = store.getLatestSnapshot(SESSION_ID);
      expect(row!.baseSeq).toBe(50n);
      expect(Array.from(row!.payload)).toEqual([0x32]);
    });

    it('isolates by session_id (does not leak across sessions)', () => {
      db.prepare(
        'INSERT INTO pty_snapshot ' +
          '(session_id, base_seq, schema_version, geometry_cols, geometry_rows, payload, created_ms) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(OTHER_SESSION, 999, 1, 80, 24, Buffer.from([0xff]), 1);

      expect(store.getLatestSnapshot(SESSION_ID)).toBeNull();
      const other = store.getLatestSnapshot(OTHER_SESSION);
      expect(other).not.toBeNull();
      expect(other!.baseSeq).toBe(999n);
    });
  });

  describe('getDeltasSince', () => {
    it('returns an empty array when no deltas exist', () => {
      expect(store.getDeltasSince(SESSION_ID, 0n)).toEqual([]);
    });

    it('returns rows in ascending seq order regardless of insert order', () => {
      const insert = db.prepare(
        'INSERT INTO pty_delta (session_id, seq, payload, ts_ms) VALUES (?, ?, ?, ?)',
      );
      insert.run(SESSION_ID, 13, Buffer.from([0x43]), 13_000);
      insert.run(SESSION_ID, 11, Buffer.from([0x41]), 11_000);
      insert.run(SESSION_ID, 12, Buffer.from([0x42]), 12_000);

      const rows = store.getDeltasSince(SESSION_ID, 10n);
      expect(rows.map((r) => r.seq)).toEqual([11n, 12n, 13n]);
      expect(rows.map((r) => r.tsUnixMs)).toEqual([11_000n, 12_000n, 13_000n]);
      expect(rows.map((r) => Array.from(r.payload))).toEqual([
        [0x41],
        [0x42],
        [0x43],
      ]);
    });

    it('respects the sinceBaseSeq exclusive lower bound', () => {
      const insert = db.prepare(
        'INSERT INTO pty_delta (session_id, seq, payload, ts_ms) VALUES (?, ?, ?, ?)',
      );
      for (let i = 1; i <= 5; i++) {
        insert.run(SESSION_ID, i, Buffer.from([i]), i * 1000);
      }

      // seq > 3 → expect 4, 5 only.
      const rows = store.getDeltasSince(SESSION_ID, 3n);
      expect(rows.map((r) => r.seq)).toEqual([4n, 5n]);
    });

    it('isolates by session_id', () => {
      db.prepare(
        'INSERT INTO pty_delta (session_id, seq, payload, ts_ms) VALUES (?, ?, ?, ?)',
      ).run(OTHER_SESSION, 1, Buffer.from([0xff]), 1);

      expect(store.getDeltasSince(SESSION_ID, 0n)).toEqual([]);
      expect(store.getDeltasSince(OTHER_SESSION, 0n).length).toBe(1);
    });
  });
});
