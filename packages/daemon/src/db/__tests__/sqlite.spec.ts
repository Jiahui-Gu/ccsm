// packages/daemon/src/db/__tests__/sqlite.spec.ts
//
// Verifies that `openDatabase()` applies every PRAGMA spec'd in
// docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch07 §3
// at boot time, by reading each value back via `db.pragma()` after the
// wrapper returns.

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOOT_PRAGMAS,
  openDatabase,
  walCheckpointPassive,
  walCheckpointTruncate,
  type SqliteDatabase,
} from '../sqlite.js';

describe('openDatabase (T5.1 — ch07 §1/§3)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: SqliteDatabase | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-daemon-sqlite-'));
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

  it('opens the database file', () => {
    db = openDatabase(dbPath);
    expect(db.open).toBe(true);
    expect(db.name).toBe(dbPath);
  });

  it('applies journal_mode = WAL', () => {
    db = openDatabase(dbPath);
    // `pragma('journal_mode', { simple: true })` returns the bare value.
    const mode = db.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe(BOOT_PRAGMAS.journal_mode);
  });

  it('applies synchronous = NORMAL (1)', () => {
    db = openDatabase(dbPath);
    // SQLite reports synchronous as an integer: OFF=0, NORMAL=1, FULL=2, EXTRA=3.
    const sync = db.pragma('synchronous', { simple: true });
    expect(sync).toBe(1);
  });

  it('applies foreign_keys = ON (1)', () => {
    db = openDatabase(dbPath);
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('applies busy_timeout = 5000', () => {
    db = openDatabase(dbPath);
    const bt = db.pragma('busy_timeout', { simple: true });
    expect(bt).toBe(BOOT_PRAGMAS.busy_timeout);
  });

  it('applies journal_size_limit = 64 MiB (67108864)', () => {
    db = openDatabase(dbPath);
    const limit = db.pragma('journal_size_limit', { simple: true });
    expect(limit).toBe(BOOT_PRAGMAS.journal_size_limit);
  });

  it('applies wal_autocheckpoint = 1000 (T5.6 — ch07 §5)', () => {
    db = openDatabase(dbPath);
    const auto = db.pragma('wal_autocheckpoint', { simple: true });
    expect(auto).toBe(BOOT_PRAGMAS.wal_autocheckpoint);
  });

  it('skips wal_autocheckpoint in read-only mode (PRAGMA is moot, T5.6)', () => {
    // Seed a DB so the read-only handle has something to open.
    const seed = openDatabase(dbPath);
    seed.close();

    db = openDatabase(dbPath, { readonly: true });
    // PRAGMA is harmless in RO mode; the assertion is that openDatabase()
    // didn't throw on the RO branch (which earlier wrappers might have if
    // they tried to mutate WAL state on a read-only connection).
    expect(db.open).toBe(true);
  });

  it('BOOT_PRAGMAS constant matches spec values', () => {
    // Lock the constants — if the spec ever changes these, this assertion
    // forces the wrapper, the constant, and this test to update together.
    expect(BOOT_PRAGMAS).toEqual({
      journal_mode: 'wal',
      synchronous: 'NORMAL',
      foreign_keys: 'ON',
      busy_timeout: 5000,
      journal_size_limit: 67108864,
      wal_autocheckpoint: 1000,
    });
  });
});

describe('WAL discipline (T5.6 — ch07 §5)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: SqliteDatabase | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-daemon-wal-'));
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

  function seedTable(handle: SqliteDatabase): void {
    handle.exec(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, payload BLOB);`);
  }

  function insertRows(handle: SqliteDatabase, count: number): void {
    const stmt = handle.prepare(`INSERT INTO t (payload) VALUES (?)`);
    // ~512 bytes per row keeps the per-test runtime tiny while still
    // generating enough -wal pages to make checkpoint behaviour visible.
    const payload = Buffer.alloc(512, 0xab);
    const txn = handle.transaction((n: number) => {
      for (let i = 0; i < n; i++) stmt.run(payload);
    });
    txn(count);
  }

  it('wal_autocheckpoint = 1000 keeps -wal bounded across sustained writes', () => {
    db = openDatabase(dbPath);
    seedTable(db);
    // 1500 rows comfortably exceeds the 1000-page autocheckpoint threshold
    // (~4 MiB of -wal at the default 4 KiB page size with 512-byte payloads
    // including overhead). After the autocheckpoint kicks in, the -wal
    // file size MUST stay under the journal_size_limit (64 MiB), and in
    // practice should be nowhere near it.
    insertRows(db, 1500);

    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      const size = statSync(walPath).size;
      // 16 MiB is a generous upper bound — autocheckpoint at 1000 pages
      // (~4 MiB) plus a transaction-in-flight buffer should never exceed
      // this. The journal_size_limit cap (64 MiB) is the spec ceiling.
      expect(size).toBeLessThan(16 * 1024 * 1024);
    }
    // -wal absence is also fine (an autocheckpoint may have truncated it).
  });

  it('walCheckpointPassive() returns a result row and does not throw', () => {
    db = openDatabase(dbPath);
    seedTable(db);
    insertRows(db, 50);

    const result = walCheckpointPassive(db);
    expect(typeof result.busy).toBe('number');
    expect(result.busy === 0 || result.busy === 1).toBe(true);
    expect(typeof result.log).toBe('number');
    expect(typeof result.checkpointed).toBe('number');
    expect(result.log).toBeGreaterThanOrEqual(0);
    expect(result.checkpointed).toBeGreaterThanOrEqual(0);
  });

  it('walCheckpointTruncate() truncates -wal to 0 bytes (or removes it)', () => {
    db = openDatabase(dbPath);
    seedTable(db);
    insertRows(db, 200);

    const walPath = `${dbPath}-wal`;
    // -wal MUST exist before the truncate checkpoint — confirms the test
    // is actually exercising the code path the spec requires.
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBeGreaterThan(0);

    const result = walCheckpointTruncate(db);
    expect(result.busy).toBe(0); // single connection, no readers blocking

    // After TRUNCATE the file is either 0 bytes OR has been unlinked by
    // SQLite. Both are spec-acceptable outcomes ("leave a clean DB on
    // disk"); test accepts either.
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }
  });

  it('graceful-shutdown sequence: TRUNCATE then close drops -wal/-shm', () => {
    db = openDatabase(dbPath);
    seedTable(db);
    insertRows(db, 200);

    walCheckpointTruncate(db);
    db.close();
    db = null;

    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    // Spec ch07 §5: shutdown checkpoint leaves a clean DB on disk —
    // -wal/-shm should be 0 bytes (if present) or absent. SQLite removes
    // -shm on the last connection close in WAL mode.
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }
    if (existsSync(shmPath)) {
      expect(statSync(shmPath).size).toBe(0);
    }
  });

  it('refuses unsupported checkpoint mode by not exposing it (FULL/RESTART)', () => {
    // Compile-time check via TypeScript is the real gate; this is a
    // runtime sanity check that the helpers we ship are limited to
    // PASSIVE and TRUNCATE per ch07 §5 ("Daemon does NOT issue
    // wal_checkpoint(FULL) or wal_checkpoint(RESTART) during normal
    // operation").
    db = openDatabase(dbPath);
    seedTable(db);
    expect(typeof walCheckpointPassive).toBe('function');
    expect(typeof walCheckpointTruncate).toBe('function');
    // No `walCheckpointFull` / `walCheckpointRestart` is intentional.
  });
});
