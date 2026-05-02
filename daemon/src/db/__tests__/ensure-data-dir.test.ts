// T34 tests: verify ensureDataDir() resolves the OS-native data root,
// provisions the directory tree, cleans orphan migration tmp files, and
// reports the canonical db file's presence as a `kind` enum.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md
// §8.2 (target), §8.3 step 1 + 1a (mkdir + orphan unlink),
// §8.5 S2 (`ccsm.db.migrating[-wal][-shm]`).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join, win32 } from 'node:path';

import {
  ensureDataDir,
  resolveDataRoot,
  type PathProvider,
} from '../ensure-data-dir.js';

// `mkdtempSync` returns a real path on every platform; we route the
// resolver into it via a fake PathProvider so tests are hermetic.
let sandbox: string;

function makeProvider(overrides: Partial<PathProvider> = {}): PathProvider {
  return {
    platform: overrides.platform ?? osPlatform(),
    home: overrides.home ?? sandbox,
    env: overrides.env ?? {},
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ccsm-ensure-data-dir-t34-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('resolveDataRoot', () => {
  it('returns %LOCALAPPDATA%\\ccsm on Windows when LOCALAPPDATA is set', () => {
    const root = resolveDataRoot(
      makeProvider({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }),
    );
    // Use win32.join for the expectation: resolveDataRoot picks the
    // TARGET platform's path flavour (win32.join), so on a Linux/macOS
    // CI host the expected separator is `\`, not the host's `/`.
    expect(root).toBe(win32.join('C:\\Users\\u\\AppData\\Local', 'ccsm'));
  });

  it('falls back to <home>\\AppData\\Local on Windows when LOCALAPPDATA is missing', () => {
    const root = resolveDataRoot(makeProvider({ platform: 'win32', home: 'C:\\Users\\u', env: {} }));
    expect(root).toBe(win32.join('C:\\Users\\u', 'AppData', 'Local', 'ccsm'));
  });

  it('returns ~/Library/Application Support/ccsm on macOS', () => {
    const root = resolveDataRoot(makeProvider({ platform: 'darwin', home: '/Users/u' }));
    expect(root).toBe('/Users/u/Library/Application Support/ccsm');
  });

  it('returns ~/.local/share/ccsm on Linux when XDG_DATA_HOME is unset', () => {
    const root = resolveDataRoot(makeProvider({ platform: 'linux', home: '/home/u', env: {} }));
    expect(root).toBe('/home/u/.local/share/ccsm');
  });

  it('honours $XDG_DATA_HOME on Linux when absolute', () => {
    const root = resolveDataRoot(
      makeProvider({ platform: 'linux', home: '/home/u', env: { XDG_DATA_HOME: '/var/data' } }),
    );
    expect(root).toBe('/var/data/ccsm');
  });

  it('ignores a relative XDG_DATA_HOME (XDG spec compliance)', () => {
    const root = resolveDataRoot(
      makeProvider({ platform: 'linux', home: '/home/u', env: { XDG_DATA_HOME: 'relative/dir' } }),
    );
    expect(root).toBe('/home/u/.local/share/ccsm');
  });
});

describe('ensureDataDir', () => {
  it('creates <dataRoot>/data when nothing exists and reports kind="fresh"', () => {
    const provider = makeProvider();
    const result = ensureDataDir(provider);

    expect(existsSync(result.dataDir)).toBe(true);
    expect(result.dataRoot).toBe(resolveDataRoot(provider));
    expect(result.dataDir).toBe(join(result.dataRoot, 'data'));
    expect(result.dbPath).toBe(join(result.dataDir, 'ccsm.db'));
    expect(result.kind).toBe('fresh');
    expect(result.orphansRemoved).toBe(0);
  });

  it('reports kind="existing" when ccsm.db is already present', () => {
    const provider = makeProvider();
    const first = ensureDataDir(provider);
    // Drop a stand-in db file (any bytes — ensureDataDir does not parse
    // SQLite; quick_check is frag-8 §8.5 S4's job, not this module's).
    writeFileSync(first.dbPath, Buffer.from([0x53, 0x51, 0x4c]));

    const second = ensureDataDir(provider);
    expect(second.kind).toBe('existing');
    expect(second.dbPath).toBe(first.dbPath);
    expect(second.orphansRemoved).toBe(0);
  });

  it('treats a zero-byte db file as kind="existing" (integrity is S4\'s job)', () => {
    const provider = makeProvider();
    const first = ensureDataDir(provider);
    writeFileSync(first.dbPath, Buffer.alloc(0));

    const second = ensureDataDir(provider);
    expect(second.kind).toBe('existing');
  });

  it('is idempotent: a pre-existing data dir is kept (no destructive recreate)', () => {
    const provider = makeProvider();
    const first = ensureDataDir(provider);
    // Drop a sibling artifact alongside the db dir to prove we don't
    // wipe its parent.
    const sentinel = join(first.dataDir, 'sentinel.txt');
    writeFileSync(sentinel, 'do-not-delete');

    const second = ensureDataDir(provider);
    expect(second.dataDir).toBe(first.dataDir);
    expect(existsSync(sentinel)).toBe(true);
  });

  it('unlinks orphan ccsm.db.migrating, -wal, and -shm tmp files (frag-8 §8.3 step 1a)', () => {
    const provider = makeProvider();
    const first = ensureDataDir(provider);
    const tmpBase = join(first.dataDir, 'ccsm.db.migrating');
    writeFileSync(tmpBase, 'orphan');
    writeFileSync(tmpBase + '-wal', 'orphan-wal');
    writeFileSync(tmpBase + '-shm', 'orphan-shm');

    const second = ensureDataDir(provider);
    expect(second.orphansRemoved).toBe(3);
    expect(existsSync(tmpBase)).toBe(false);
    expect(existsSync(tmpBase + '-wal')).toBe(false);
    expect(existsSync(tmpBase + '-shm')).toBe(false);
  });

  it('only counts orphans that actually existed (partial leftovers ok)', () => {
    const provider = makeProvider();
    const first = ensureDataDir(provider);
    // Only the main tmp file leaks (e.g. process died before opening WAL).
    writeFileSync(join(first.dataDir, 'ccsm.db.migrating'), 'orphan');

    const second = ensureDataDir(provider);
    expect(second.orphansRemoved).toBe(1);
  });

  it('orphan cleanup runs alongside kind="existing" probe', () => {
    const provider = makeProvider();
    const first = ensureDataDir(provider);
    writeFileSync(first.dbPath, Buffer.from([0x53, 0x51, 0x4c]));
    writeFileSync(join(first.dataDir, 'ccsm.db.migrating'), 'orphan');

    const second = ensureDataDir(provider);
    expect(second.kind).toBe('existing');
    expect(second.orphansRemoved).toBe(1);
  });

  it('creates intermediate parent directories (mkdir -p semantics)', () => {
    // Point the provider at a freshly-minted home with no AppData/Local
    // / .local/share scaffolding — recursive mkdir must conjure all of it.
    const deepHome = join(sandbox, 'fresh', 'profile');
    mkdirSync(deepHome, { recursive: true });
    const provider = makeProvider({ home: deepHome });

    const result = ensureDataDir(provider);
    expect(existsSync(result.dataDir)).toBe(true);
    expect(result.dataRoot.startsWith(deepHome)).toBe(true);
  });

  it('applies user-only mode 0700 to the newly-created data dir on Unix', () => {
    if (osPlatform() === 'win32') return; // ACL-based; mode bits are NTFS noise.
    const provider = makeProvider();
    const result = ensureDataDir(provider);
    const mode = statSync(result.dataDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('is callable without arguments (defaultPathProvider) — smoke', () => {
    // Real-env smoke: the function must not throw when no provider is
    // injected. We don't assert side effects on the real user profile;
    // just that it returns a non-empty string contract.
    // Mark as skipped on CI nodes where writing to LOCALAPPDATA is
    // undesirable (we only want to exercise the resolve+exist flow,
    // and the dir may already exist from a prior install).
    const result = ensureDataDir();
    expect(result.dataRoot.length).toBeGreaterThan(0);
    expect(result.dataDir.endsWith('data')).toBe(true);
    expect(result.dbPath.endsWith('ccsm.db')).toBe(true);
    // Cleanup: do NOT rmSync the real data dir — it may belong to the
    // dev's actual ccsm install.
  });
});
