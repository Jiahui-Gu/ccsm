// packages/daemon/test/state-dir/paths.spec.ts
//
// FOREVER-STABLE invariants test for the per-OS daemon state-directory layout.
//
// Spec source of truth: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//   - chapter 07 §2 — "State directory layout (per OS)" — locks the daemon
//     state root, descriptor file, DB path, and crash-raw NDJSON file per OS.
//   - chapter 07 §2 also locks: paths created with mode 0700 for the daemon's
//     service account; descriptor file mode 0644 (set by the writer in T1.6);
//     XDG_DATA_HOME explicitly NOT respected on linux ("the daemon may run
//     with no logged-in user").
//   - chapter 12 §7 — performance / invariants; this spec is the testing-side
//     enforcement that the locked snapshot does not drift across releases.
//
// Implementation under test (PR #862 / Task T5.3):
//   packages/daemon/src/state-dir/paths.ts
//
// What this test guarantees:
//   1. The constants resolved by `statePaths()` with default args are
//      byte-identical, per `process.platform` branch (win32 / darwin / linux),
//      to the locked snapshot below. Any future drift fails CI.
//   2. NO env var (other than the win32-specific %PROGRAMDATA%, which is the
//      OS-defined root location, NOT a user override) influences the resolved
//      paths on darwin or linux. In particular: XDG_DATA_HOME, XDG_CONFIG_HOME,
//      XDG_RUNTIME_DIR, HOME, USER, APPDATA, LOCALAPPDATA, TMPDIR, CCSM_*,
//      CCSM_STATE_DIR, etc. are all ignored — there is no env-var override
//      sneaking in.
//   3. The returned StatePaths object is `Object.isFrozen`, so callers cannot
//      mutate the locked layout at runtime.
//   4. STATE_DIR_MODE is 0o700 per ch07 §2.
//
// Co-located with `packages/daemon/test/db/migration-lock.spec.ts` (T10.1) —
// the established home for forever-stable invariant specs that watch shipped
// constants for accidental drift.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STATE_DIR_MODE, statePaths } from '../../src/state-dir/paths.js';

// ---------------------------------------------------------------------------
// Locked snapshot per OS — derived from spec ch07 §2 and pinned by PR #862.
//
// These are the EXACT bytes daemon callers receive from `statePaths()` for
// the corresponding `process.platform` value. If a future change alters any
// path (e.g. moves descriptor under a subdir, renames `sessions.db`, switches
// linux root off /var/lib/ccsm), this test fails — that is the contract.
//
// Note on win32: %PROGRAMDATA% is the OS-defined location of the per-machine
// program data root, NOT a user-tweakable override. Spec ch07 §2 names it
// explicitly ("Windows | %PROGRAMDATA%\\ccsm\\"). The fallback to
// `C:\\ProgramData` matches the documented Windows default and is exercised
// here so dev runs on a stripped env still resolve deterministically.
// ---------------------------------------------------------------------------

const LOCKED = {
  win32_with_programdata: {
    env: { PROGRAMDATA: 'C:\\ProgramData' } as NodeJS.ProcessEnv,
    expected: {
      root: 'C:\\ProgramData\\ccsm',
      descriptor: 'C:\\ProgramData\\ccsm\\listener-a.json',
      descriptorsDir: 'C:\\ProgramData\\ccsm\\descriptors',
      sessionsDb: 'C:\\ProgramData\\ccsm\\sessions.db',
      crashRaw: 'C:\\ProgramData\\ccsm\\crash-raw.ndjson',
    },
  },
  win32_alt_drive_programdata: {
    env: { PROGRAMDATA: 'D:\\ProgramData' } as NodeJS.ProcessEnv,
    expected: {
      root: 'D:\\ProgramData\\ccsm',
      descriptor: 'D:\\ProgramData\\ccsm\\listener-a.json',
      descriptorsDir: 'D:\\ProgramData\\ccsm\\descriptors',
      sessionsDb: 'D:\\ProgramData\\ccsm\\sessions.db',
      crashRaw: 'D:\\ProgramData\\ccsm\\crash-raw.ndjson',
    },
  },
  win32_no_programdata: {
    env: {} as NodeJS.ProcessEnv,
    expected: {
      root: 'C:\\ProgramData\\ccsm',
      descriptor: 'C:\\ProgramData\\ccsm\\listener-a.json',
      descriptorsDir: 'C:\\ProgramData\\ccsm\\descriptors',
      sessionsDb: 'C:\\ProgramData\\ccsm\\sessions.db',
      crashRaw: 'C:\\ProgramData\\ccsm\\crash-raw.ndjson',
    },
  },
  darwin: {
    env: {} as NodeJS.ProcessEnv,
    expected: {
      root: '/Library/Application Support/ccsm',
      descriptor: '/Library/Application Support/ccsm/listener-a.json',
      descriptorsDir: '/Library/Application Support/ccsm/descriptors',
      sessionsDb: '/Library/Application Support/ccsm/sessions.db',
      crashRaw: '/Library/Application Support/ccsm/crash-raw.ndjson',
    },
  },
  linux: {
    env: {} as NodeJS.ProcessEnv,
    expected: {
      root: '/var/lib/ccsm',
      descriptor: '/var/lib/ccsm/listener-a.json',
      descriptorsDir: '/var/lib/ccsm/descriptors',
      sessionsDb: '/var/lib/ccsm/sessions.db',
      crashRaw: '/var/lib/ccsm/crash-raw.ndjson',
    },
  },
} as const;

// Env vars that MUST NOT influence path resolution on darwin or linux. If
// any of these ever start affecting `statePaths()` output, the daemon has
// silently grown an env-var override surface — exactly what ch07 §2 forbids
// ("Do not respect XDG_DATA_HOME for daemon state — the daemon may run with
// no logged-in user").
const FORBIDDEN_ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'CCSM_STATE_DIR',
  'CCSM_DATA_DIR',
  'CCSM_HOME',
  'CCSM_ROOT',
  'CCSM_CONFIG',
] as const;

// Mock `process.platform` for the duration of one test. `process.platform` is
// a non-writable accessor on Node, so we use `Object.defineProperty` and
// restore afterwards. This mirrors how the rest of the daemon test suite
// stubs `process.platform` (e.g. `process-platform` style fixtures).
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    } else {
      // Original descriptor missing is impossible on Node — guard anyway.
      Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
    }
  }
}

// Snapshot + restore selected env keys around a test so the host CI env
// (which DOES set XDG_*, HOME, etc.) cannot taint or be tainted by the test.
const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv(keys: readonly string[]): void {
  for (const k of keys) {
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

// ---------------------------------------------------------------------------
// 1. Byte-identical snapshot per platform — default-args path resolution.
//
// Mocks `process.platform` so the test runs identically on any host OS;
// passes a controlled env explicitly so the win32 %PROGRAMDATA% branch is
// deterministic and the darwin/linux branches see an empty env.
// ---------------------------------------------------------------------------

describe('statePaths — locked per-OS snapshot (ch07 §2)', () => {
  it('win32 with %PROGRAMDATA%=C:\\ProgramData resolves to the locked layout', () => {
    withPlatform('win32', () => {
      const got = statePaths(undefined, LOCKED.win32_with_programdata.env);
      expect(got).toEqual(LOCKED.win32_with_programdata.expected);
    });
  });

  it('win32 with %PROGRAMDATA% pointing at a non-C: drive still resolves correctly', () => {
    withPlatform('win32', () => {
      const got = statePaths(undefined, LOCKED.win32_alt_drive_programdata.env);
      expect(got).toEqual(LOCKED.win32_alt_drive_programdata.expected);
    });
  });

  it('win32 with %PROGRAMDATA% unset falls back to the documented C:\\ProgramData default', () => {
    withPlatform('win32', () => {
      const got = statePaths(undefined, LOCKED.win32_no_programdata.env);
      expect(got).toEqual(LOCKED.win32_no_programdata.expected);
    });
  });

  it('darwin resolves to the system-wide /Library/Application Support/ccsm tree', () => {
    withPlatform('darwin', () => {
      const got = statePaths(undefined, LOCKED.darwin.env);
      expect(got).toEqual(LOCKED.darwin.expected);
    });
  });

  it('linux resolves to /var/lib/ccsm (FHS, system-service)', () => {
    withPlatform('linux', () => {
      const got = statePaths(undefined, LOCKED.linux.env);
      expect(got).toEqual(LOCKED.linux.expected);
    });
  });

  it('unknown POSIX platforms (freebsd, openbsd, sunos) fall through to the linux branch', () => {
    for (const plat of ['freebsd', 'openbsd', 'sunos', 'aix'] as const) {
      withPlatform(plat as NodeJS.Platform, () => {
        const got = statePaths(undefined, {});
        expect(got).toEqual(LOCKED.linux.expected);
      });
    }
  });

  it('returned StatePaths object is frozen on every platform branch', () => {
    for (const plat of ['win32', 'darwin', 'linux'] as const) {
      withPlatform(plat, () => {
        const got = statePaths(undefined, plat === 'win32' ? { PROGRAMDATA: 'C:\\ProgramData' } : {});
        expect(Object.isFrozen(got)).toBe(true);
      });
    }
  });

  it('STATE_DIR_MODE is exactly 0o700 (ch07 §2 — daemon service-account perms)', () => {
    expect(STATE_DIR_MODE).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// 2. No env-var override sneaking in.
//
// For each forbidden env key, set it to a clearly-bogus value, then assert
// that the resolved paths on darwin and linux are byte-identical to the
// locked snapshot. Any divergence means an env-var override has crept in.
//
// We test via BOTH: (a) explicit `env` arg (the supported test seam), and
// (b) default arg (i.e. the function reading `process.env` itself). Both
// must be immune.
// ---------------------------------------------------------------------------

describe('statePaths — no env-var override on darwin/linux (ch07 §2)', () => {
  beforeEach(() => {
    saveEnv(FORBIDDEN_ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv();
  });

  for (const plat of ['darwin', 'linux'] as const) {
    const expected = LOCKED[plat].expected;

    it(`${plat}: setting any single forbidden env key does not affect resolved paths (explicit env arg)`, () => {
      withPlatform(plat, () => {
        for (const key of FORBIDDEN_ENV_KEYS) {
          const tainted: NodeJS.ProcessEnv = { [key]: '/totally-bogus/should-be-ignored' };
          const got = statePaths(undefined, tainted);
          expect(
            got,
            `forbidden env key ${key}=/totally-bogus/... must not influence ${plat} paths`,
          ).toEqual(expected);
        }
      });
    });

    it(`${plat}: setting ALL forbidden env keys at once does not affect resolved paths (explicit env arg)`, () => {
      withPlatform(plat, () => {
        const tainted: NodeJS.ProcessEnv = {};
        for (const key of FORBIDDEN_ENV_KEYS) {
          tainted[key] = `/totally-bogus/${key.toLowerCase()}`;
        }
        const got = statePaths(undefined, tainted);
        expect(got).toEqual(expected);
      });
    });

    it(`${plat}: setting all forbidden env keys via process.env (default arg) does not affect resolved paths`, () => {
      withPlatform(plat, () => {
        for (const key of FORBIDDEN_ENV_KEYS) {
          process.env[key] = `/totally-bogus/${key.toLowerCase()}`;
        }
        // Default `env` arg — the function reads process.env itself.
        const got = statePaths();
        expect(got).toEqual(expected);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 3. win32 — only %PROGRAMDATA% is honoured; every other env key is ignored.
//
// %PROGRAMDATA% is the OS-defined per-machine program-data root, not a user
// override. Spec ch07 §2 names it explicitly. Every OTHER env key (including
// %APPDATA% and %LOCALAPPDATA%, both of which ch07 §2 expressly forbids) MUST
// have zero effect on the resolved paths.
// ---------------------------------------------------------------------------

describe('statePaths — win32 only honours %PROGRAMDATA% (ch07 §2)', () => {
  beforeEach(() => {
    saveEnv(FORBIDDEN_ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv();
  });

  it('setting any forbidden env key alongside %PROGRAMDATA% does not change the resolved layout', () => {
    withPlatform('win32', () => {
      for (const key of FORBIDDEN_ENV_KEYS) {
        const tainted: NodeJS.ProcessEnv = {
          PROGRAMDATA: 'C:\\ProgramData',
          [key]: 'C:\\totally-bogus\\should-be-ignored',
        };
        const got = statePaths(undefined, tainted);
        expect(
          got,
          `forbidden env key ${key} must not influence win32 paths`,
        ).toEqual(LOCKED.win32_with_programdata.expected);
      }
    });
  });

  it('%APPDATA% and %LOCALAPPDATA% must not become the daemon root (ch07 §2 forbids both)', () => {
    withPlatform('win32', () => {
      const tainted: NodeJS.ProcessEnv = {
        PROGRAMDATA: 'C:\\ProgramData',
        APPDATA: 'C:\\Users\\evil\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\evil\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\evil',
      };
      const got = statePaths(undefined, tainted);
      expect(got.root).toBe('C:\\ProgramData\\ccsm');
      expect(got.root).not.toContain('AppData');
      expect(got.root).not.toContain('evil');
    });
  });
});
