// packages/daemon/test/state-dir/env-consistency.spec.ts
//
// Cross-module consistency invariant: `buildDaemonEnv().paths.stateDir` MUST
// equal `statePaths().root` for the running platform. The two paths are
// independent code paths today (env.ts has its own `defaultStateDir()`), but
// they describe the SAME directory on disk per spec ch07 §2 ("Daemon state
// root" column). Drift between them is a per-OS off-by-one bug — exactly
// what shipped in env.ts before this fix:
//
//   env.defaultStateDir()         statePaths().root
//   ----------------------------  ------------------------------
//   win32:  <PROGRAMDATA>/ccsm/state    <PROGRAMDATA>\ccsm
//   darwin: /Library/.../ccsm/state    /Library/.../ccsm
//   linux:  /var/lib/ccsm                /var/lib/ccsm
//
// (Per-OS off-by-one: linux is consistent, win32/darwin are NOT. Diagnosed
// out-of-scope while reviewing PR #931 / Task #182.)
//
// `state-dir/paths.ts` is the file-layout module and its `statePaths()` is
// the FROZEN single source of truth (test/state-dir/paths.spec.ts golden,
// T10.7 / Task #122). env.ts MUST delegate to it; this spec is the gate.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemonEnv } from '../../src/env.js';
import { statePaths, statePathsFromRoot } from '../../src/state-dir/paths.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCSM_STATE_DIR', 'PROGRAMDATA'] as const;

function saveEnv(): void {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of Object.keys(SAVED_ENV)) {
    const v = SAVED_ENV[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  for (const k of Object.keys(SAVED_ENV)) {
    delete SAVED_ENV[k];
  }
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    } else {
      Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
    }
  }
}

describe('env.paths.stateDir vs statePaths().root — single source of truth (ch07 §2)', () => {
  beforeEach(() => {
    saveEnv();
    // Force the default branch (no CCSM_STATE_DIR override) — we are
    // testing the per-OS *default* resolution, which is where the off-by-
    // one lived.
    delete process.env.CCSM_STATE_DIR;
  });

  afterEach(() => {
    restoreEnv();
  });

  it('win32: env.paths.stateDir == statePaths().root (no /state off-by-one)', () => {
    process.env.PROGRAMDATA = 'C:\\ProgramData';
    withPlatform('win32', () => {
      const env = buildDaemonEnv();
      const sp = statePaths();
      expect(env.paths.stateDir).toBe(sp.root);
    });
  });

  it('darwin: env.paths.stateDir == statePaths().root (no /state off-by-one)', () => {
    withPlatform('darwin', () => {
      const env = buildDaemonEnv();
      const sp = statePaths();
      expect(env.paths.stateDir).toBe(sp.root);
    });
  });

  it('linux: env.paths.stateDir == statePaths().root', () => {
    withPlatform('linux', () => {
      const env = buildDaemonEnv();
      const sp = statePaths();
      expect(env.paths.stateDir).toBe(sp.root);
    });
  });

  it('descriptorPath default sits directly under statePaths().root (ch07 §2 — listener-a.json at root, NOT under /state)', () => {
    delete process.env.CCSM_DESCRIPTOR_PATH;
    for (const plat of ['win32', 'darwin', 'linux'] as const) {
      if (plat === 'win32') process.env.PROGRAMDATA = 'C:\\ProgramData';
      withPlatform(plat, () => {
        const env = buildDaemonEnv();
        const sp = statePaths();
        // Descriptor path must be `<root>/listener-a.json` exactly — same
        // root as the file-layout module owns.
        expect(env.paths.descriptorPath).toBe(sp.descriptor);
      });
    }
  });

  it('CCSM_STATE_DIR override still wins (env shape preserved)', () => {
    process.env.CCSM_STATE_DIR = '/tmp/ccsm-override';
    withPlatform('linux', () => {
      const env = buildDaemonEnv();
      expect(env.paths.stateDir).toBe('/tmp/ccsm-override');
    });
  });

  // Task #446: regression — `index.ts` previously called `statePaths()` with
  // no args to resolve `dbPath` and `crashRawPath`, which silently bypassed
  // `CCSM_STATE_DIR` (paths.ts only honours `PROGRAMDATA`). The fix is to
  // rebase via `statePathsFromRoot(env.paths.stateDir)`. This spec asserts
  // that the rebased layout points the DB and crash-raw NDJSON under the
  // override root, NOT under `/var/lib/ccsm` / `%PROGRAMDATA%\ccsm`.
  it('Task #446: statePathsFromRoot(env.paths.stateDir) honours CCSM_STATE_DIR for db + crashRaw', () => {
    process.env.CCSM_STATE_DIR = '/tmp/test1';
    withPlatform('linux', () => {
      const env = buildDaemonEnv();
      const sp = statePathsFromRoot(env.paths.stateDir, 'linux');
      expect(sp.root).toBe('/tmp/test1');
      expect(sp.db).toBe('/tmp/test1/ccsm.db');
      expect(sp.crashRaw).toBe('/tmp/test1/crash-raw.ndjson');
      expect(sp.descriptor).toBe('/tmp/test1/listener-a.json');
      // Negative: the bare `statePaths()` resolver still ignores the env
      // (proves the bypass surface is in the call site, not in paths.ts).
      const bare = statePaths('linux');
      expect(bare.db).toBe('/var/lib/ccsm/ccsm.db');
      expect(bare.db).not.toBe(sp.db);
    });
  });

  it('Task #446: win32 statePathsFromRoot uses backslash join under override', () => {
    process.env.CCSM_STATE_DIR = 'D:\\custom\\ccsm';
    withPlatform('win32', () => {
      const env = buildDaemonEnv();
      const sp = statePathsFromRoot(env.paths.stateDir, 'win32');
      expect(sp.root).toBe('D:\\custom\\ccsm');
      expect(sp.db).toBe('D:\\custom\\ccsm\\ccsm.db');
      expect(sp.crashRaw).toBe('D:\\custom\\ccsm\\crash-raw.ndjson');
    });
  });
});
