// Tests for db.mts (Task #666). Covers:
//   1. round-trip set/get
//   2. missing key returns null
//   3. persistence across close/reopen
//   4. corruption detection — non-sqlite junk file is backed up and replaced

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-db-test-'));
  dbPath = path.join(tmpDir, 'ccsm.db');
});

afterEach(() => {
  // Clean up the whole tmpdir (db + wal/shm + corrupt backups).
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('openDb', () => {
  it('round-trips a set/get', () => {
    const db = openDb({ path: dbPath });
    try {
      db.set('foo', 'bar');
      expect(db.get('foo')).toBe('bar');
    } finally {
      db.close();
    }
  });

  it('returns null for a missing key', () => {
    const db = openDb({ path: dbPath });
    try {
      expect(db.get('nope')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('persists values across close + reopen', () => {
    const db1 = openDb({ path: dbPath });
    db1.set('hello', 'world');
    db1.close();

    const db2 = openDb({ path: dbPath });
    try {
      expect(db2.get('hello')).toBe('world');
    } finally {
      db2.close();
    }
  });

  it('detects a corrupt db file, backs it up, and opens fresh', () => {
    // Drop a non-sqlite junk file at the db path.
    fs.writeFileSync(dbPath, 'this is definitely not a sqlite database file');

    const db = openDb({ path: dbPath });
    try {
      // Fresh db should be readable / writable.
      expect(db.get('anything')).toBeNull();
      db.set('after', 'recovery');
      expect(db.get('after')).toBe('recovery');
    } finally {
      db.close();
    }

    // A backup with the .corrupt-<ts> suffix should exist alongside the new db.
    const entries = fs.readdirSync(tmpDir);
    const backups = entries.filter((name) => /\.corrupt-\d+$/.test(name));
    expect(backups.length).toBeGreaterThan(0);
  });
});
