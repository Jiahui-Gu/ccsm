// Task #132 (frag-11 §11.6): verify the daemon's `migrateLegacyUppercaseDataRoot`
// helper renames a legacy capital-`CCSM` sibling into the canonical lowercase
// `ccsm` location, and that `resolveDataRoot` itself never emits an uppercase
// segment for any platform.
//
// Uppercase `CCSM` literals in this file are the legacy-path fixtures the
// migration helper exists to handle — disable the local rule for the whole
// file rather than tagging each occurrence.
/* eslint-disable ccsm-local/no-uppercase-ccsm-path */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

import {
  ensureDataDir,
  resolveDataRoot,
  migrateLegacyUppercaseDataRoot,
  type PathProvider,
} from '../ensure-data-dir.js';

// The migration helper is only meaningful on case-sensitive filesystems.
// Windows treats `CCSM` and `ccsm` as the same inode, so the legacy sibling
// check trivially short-circuits — and any rename "succeeds" by being a
// no-op. We gate the behavioural tests on a non-Windows host; the pure
// `resolveDataRoot` invariant test runs everywhere.
const describeOnPosix = osPlatform() === 'win32' ? describe.skip : describe;

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ccsm-task132-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('Task #132 — lowercase data root (frag-11 §11.6)', () => {
  it('resolveDataRoot never emits an uppercase CCSM segment on any platform', () => {
    const win = resolveDataRoot({ platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } });
    const mac = resolveDataRoot({ platform: 'darwin', home: '/Users/u', env: {} });
    const lin = resolveDataRoot({ platform: 'linux', home: '/home/u', env: {} });
    const xdg = resolveDataRoot({ platform: 'linux', home: '/home/u', env: { XDG_DATA_HOME: '/var/data' } });
    for (const r of [win, mac, lin, xdg]) {
      // The lowercase `ccsm` segment must be present, the uppercase one
      // must NOT — anywhere in the resolved path.
      expect(r.toLowerCase()).toContain('ccsm');
      expect(r).not.toMatch(/[\\/]CCSM([\\/]|$)/);
    }
  });

  describeOnPosix('migrateLegacyUppercaseDataRoot', () => {
    it('renames a legacy capital-CCSM sibling to the canonical lowercase path', () => {
      const parent = join(sandbox, '.local', 'share');
      mkdirSync(parent, { recursive: true });
      const legacy = join(parent, 'CCSM');
      const canonical = join(parent, 'ccsm');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'marker'), 'legacy-content');

      migrateLegacyUppercaseDataRoot(canonical);

      expect(existsSync(canonical)).toBe(true);
      expect(existsSync(legacy)).toBe(false);
      expect(readFileSync(join(canonical, 'marker'), 'utf8')).toBe('legacy-content');
    });

    it('is a no-op when the canonical path already exists', () => {
      const parent = join(sandbox, '.local', 'share');
      mkdirSync(parent, { recursive: true });
      const legacy = join(parent, 'CCSM');
      const canonical = join(parent, 'ccsm');
      mkdirSync(legacy, { recursive: true });
      mkdirSync(canonical, { recursive: true });
      writeFileSync(join(canonical, 'keep'), 'canonical-content');

      migrateLegacyUppercaseDataRoot(canonical);

      // Both must still exist; we don't clobber the canonical one.
      expect(existsSync(canonical)).toBe(true);
      expect(existsSync(legacy)).toBe(true);
      expect(readFileSync(join(canonical, 'keep'), 'utf8')).toBe('canonical-content');
    });

    it('is a no-op when no legacy directory exists', () => {
      const parent = join(sandbox, '.local', 'share');
      mkdirSync(parent, { recursive: true });
      const canonical = join(parent, 'ccsm');
      // Should not throw.
      migrateLegacyUppercaseDataRoot(canonical);
      expect(existsSync(canonical)).toBe(false);
    });
  });

  describeOnPosix('ensureDataDir wires the migration on non-Windows', () => {
    it('adopts a legacy CCSM/ data directory on Linux', () => {
      const provider: PathProvider = { platform: 'linux', home: sandbox, env: {} };
      const parent = join(sandbox, '.local', 'share');
      mkdirSync(join(parent, 'CCSM', 'data'), { recursive: true });
      writeFileSync(join(parent, 'CCSM', 'data', 'ccsm.db'), 'legacy-db');

      const ensured = ensureDataDir(provider);

      expect(ensured.dataRoot).toBe(join(parent, 'ccsm'));
      expect(ensured.kind).toBe('existing');
      expect(readFileSync(ensured.dbPath, 'utf8')).toBe('legacy-db');
      expect(existsSync(join(parent, 'CCSM'))).toBe(false);
    });
  });
});
