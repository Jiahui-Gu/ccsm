// Tests for db.mts (Task #666). Covers:
//   1. round-trip set/get
//   2. missing key returns null
//   3. persistence across close/reopen
//   4. corruption detection — non-sqlite junk file is backed up and replaced
//   5. ccsm-web → ccsm legacy default-path fallback (Task #730)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultDbPath,
  legacyDefaultDbPath,
  openDb,
  resolveDefaultDbPath,
} from './db.mjs';

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

describe('resolveDefaultDbPath (ccsm-web → ccsm legacy fallback)', () => {
  let homeDir: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let savedAppData: string | undefined;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-home-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    savedAppData = process.env.APPDATA;
    // Redirect %APPDATA% (used by defaultDbPath on win32) into our fake home so
    // the test is hermetic on every platform.
    process.env.APPDATA = path.join(homeDir, 'AppData/Roaming');
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns the new path when no db file exists at either location', () => {
    expect(resolveDefaultDbPath()).toBe(defaultDbPath());
  });

  it('returns the new path when both files exist (legacy ignored)', () => {
    const newPath = defaultDbPath();
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, '');
    const legacy = legacyDefaultDbPath();
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '');

    expect(resolveDefaultDbPath()).toBe(newPath);
  });

  it('falls back to the legacy ccsm-web path when only legacy exists', () => {
    const legacy = legacyDefaultDbPath();
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(resolveDefaultDbPath()).toBe(legacy);
      const warned = stderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('legacy db'),
      );
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('legacy and current paths differ (sanity check for the rename)', () => {
    expect(legacyDefaultDbPath()).not.toBe(defaultDbPath());
    expect(legacyDefaultDbPath()).toMatch(/ccsm-web/);
    expect(defaultDbPath()).not.toMatch(/ccsm-web/);
  });
});
