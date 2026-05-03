// packages/daemon/src/db/__tests__/recovery.spec.ts
//
// Boot-time corrupt-DB recovery (T5.7 / Task #60). Spec ch07 §6.

import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadNative } from '../../native-loader.js';
import { checkAndRecover, makeRecoveryFlag } from '../recovery.js';

const Database = loadNative('better_sqlite3');

describe('checkAndRecover (T5.7 — ch07 §6)', () => {
  let tmpDir: string;
  let dbPath: string;
  let crashRawPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-daemon-recovery-'));
    dbPath = join(tmpDir, 'ccsm.db');
    crashRawPath = join(tmpDir, 'crash-raw.ndjson');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------- //
  // first boot — DB file does not exist                                   //
  // --------------------------------------------------------------------- //

  it('is a no-op when the DB file does not exist (first boot)', () => {
    const flag = makeRecoveryFlag();
    const result = checkAndRecover({ dbPath, crashRawPath, flag });
    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.corruptPath).toBe('');
    expect(flag.read().pending).toBe(false);
    expect(existsSync(crashRawPath)).toBe(false);
  });

  // --------------------------------------------------------------------- //
  // healthy DB — integrity_check returns 'ok'                             //
  // --------------------------------------------------------------------- //

  it('is a no-op for a healthy DB (integrity_check returns "ok")', () => {
    // Create a healthy DB with a tiny schema.
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    seed.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    seed.close();

    const flag = makeRecoveryFlag();
    const result = checkAndRecover({ dbPath, crashRawPath, flag });
    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.corruptPath).toBe('');
    expect(flag.read().pending).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(crashRawPath)).toBe(false);
  });

  // --------------------------------------------------------------------- //
  // corrupt DB — random-byte scribble mid-page                            //
  // --------------------------------------------------------------------- //

  it('renames the DB and writes an NDJSON line on integrity-check failure', () => {
    // Build a real DB then scribble random bytes mid-file to corrupt it.
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    for (let i = 0; i < 200; i += 1) {
      seed.prepare('INSERT INTO t (v) VALUES (?)').run(`row-${i}`);
    }
    seed.close();

    // Open the file and overwrite a chunk of bytes well past the SQLite
    // header (offset 4096 = page 2). 1 KiB of garbage is enough to make
    // PRAGMA integrity_check fail without preventing the file from opening.
    const fd = openSync(dbPath, 'r+');
    try {
      const garbage = Buffer.alloc(1024, 0xff);
      writeSync(fd, garbage, 0, garbage.length, 4096);
    } finally {
      closeSync(fd);
    }

    const flag = makeRecoveryFlag();
    const fixedNow = 1_700_000_123_000;
    const result = checkAndRecover({
      dbPath,
      crashRawPath,
      flag,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(false);
    expect(result.recovered).toBe(true);
    expect(result.corruptPath).toBe(`${dbPath}.corrupt-${fixedNow}`);

    // Original DB path is now empty (renamed).
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.corrupt-${fixedNow}`)).toBe(true);

    // Recovery flag is set.
    expect(flag.read()).toEqual({
      pending: true,
      ts_ms: fixedNow,
      corrupt_path: `${dbPath}.corrupt-${fixedNow}`,
    });

    // NDJSON line was appended with the locked shape.
    const ndjson = readFileSync(crashRawPath, 'utf8');
    expect(ndjson.endsWith('\n')).toBe(true);
    const line = JSON.parse(ndjson.trim()) as Record<string, unknown>;
    expect(line.source).toBe('sqlite_corruption_recovered');
    expect(line.owner_id).toBe('daemon-self');
    expect(line.ts_ms).toBe(fixedNow);
    expect(line.id).toBe(`corrupt-db-${fixedNow}`);
    expect(typeof line.summary).toBe('string');
    expect(String(line.summary)).toContain('renamed db to');
    expect(typeof line.detail).toBe('string');
    const labels = line.labels as Record<string, unknown>;
    expect(labels.corrupt_path).toBe(`${dbPath}.corrupt-${fixedNow}`);
    expect(labels.db_path).toBe(dbPath);
  });

  // --------------------------------------------------------------------- //
  // unrecoverable file — PRAGMA throws                                    //
  // --------------------------------------------------------------------- //

  it('writes status:unrecoverable when SQLite cannot open the file at all', () => {
    // Write garbage that doesn't even resemble a SQLite header.
    const fd = openSync(dbPath, 'w');
    try {
      writeSync(fd, Buffer.from('not a sqlite database at all', 'utf8'));
    } finally {
      closeSync(fd);
    }

    const flag = makeRecoveryFlag();
    const fixedNow = 1_700_000_222_000;
    const result = checkAndRecover({
      dbPath,
      crashRawPath,
      flag,
      now: () => fixedNow,
    });

    expect(result.recovered).toBe(true);
    expect(result.corruptPath).toBe(`${dbPath}.corrupt-${fixedNow}`);
    expect(flag.read().pending).toBe(true);

    const ndjson = readFileSync(crashRawPath, 'utf8');
    const line = JSON.parse(ndjson.trim()) as Record<string, unknown>;
    expect(line.source).toBe('sqlite_corruption_recovered');
    // detail field is the JSON-encoded { status: 'unrecoverable', ... } payload.
    const detail = JSON.parse(String(line.detail)) as Record<string, unknown>;
    expect(detail.status).toBe('unrecoverable');
    expect(typeof detail.error).toBe('string');
  });
});

describe('makeRecoveryFlag', () => {
  it('starts cleared (pending=false, ts_ms=0, corrupt_path="")', () => {
    const flag = makeRecoveryFlag();
    expect(flag.read()).toEqual({ pending: false, ts_ms: 0, corrupt_path: '' });
  });

  it('set + read returns the new state', () => {
    const flag = makeRecoveryFlag();
    flag.set(123, '/x/y.corrupt-123');
    expect(flag.read()).toEqual({
      pending: true,
      ts_ms: 123,
      corrupt_path: '/x/y.corrupt-123',
    });
  });

  it('clear resets to initial state', () => {
    const flag = makeRecoveryFlag();
    flag.set(123, '/x/y.corrupt-123');
    flag.clear();
    expect(flag.read()).toEqual({ pending: false, ts_ms: 0, corrupt_path: '' });
  });

  it('read returns a frozen snapshot (mutating the result does not affect state)', () => {
    const flag = makeRecoveryFlag();
    flag.set(100, '/a');
    const snap = flag.read() as unknown as { pending: boolean };
    expect(() => {
      snap.pending = false;
    }).toThrow();
    // Still pending after the mutation attempt.
    expect(flag.read().pending).toBe(true);
  });
});
