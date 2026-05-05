// packages/daemon/src/pty-host/__tests__/spawn-env.spec.ts
//
// Unit tests for `computeUtf8SpawnEnv` (Task #436 coverage sweep).
// Pure decider — spec ch06 §1 UTF-8 contract:
//   linux  → LANG=LC_ALL=C.UTF-8
//   darwin → LANG=LC_ALL=<probed locale, default C.UTF-8>
//   win32  → PYTHONIOENCODING=utf-8
// In every case the contract keys WIN over inherited / envExtra.

import { describe, expect, it } from 'vitest';

import {
  computeUtf8SpawnEnv,
  UTF8_CONTRACT_KEYS_POSIX,
  UTF8_CONTRACT_KEYS_WIN32,
} from '../spawn-env.js';

describe('computeUtf8SpawnEnv — linux', () => {
  it('sets LANG=LC_ALL=C.UTF-8 on a clean inherited env', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: { PATH: '/usr/bin' },
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  it('UTF-8 contract OVERRIDES inherited LANG/LC_ALL', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: { LANG: 'fr_FR.UTF-8', LC_ALL: 'POSIX' },
    });
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  it('drops undefined values from inherited env', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: { DEFINED: 'yes', MISSING: undefined },
    });
    expect(env.DEFINED).toBe('yes');
    expect('MISSING' in env).toBe(false);
  });

  it('envExtra wins over inherited but loses to UTF-8 contract', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: { FOO: 'inherited', LANG: 'fr_FR.UTF-8' },
      envExtra: { FOO: 'extra', LANG: 'en_GB.UTF-8' },
    });
    expect(env.FOO).toBe('extra');
    expect(env.LANG).toBe('C.UTF-8'); // contract still wins
  });
});

describe('computeUtf8SpawnEnv — darwin', () => {
  it('defaults to C.UTF-8 when darwinFallbackLocale is absent', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'darwin',
      inheritedEnv: {},
    });
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  it('honors darwinFallbackLocale when set (e.g. en_US.UTF-8)', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'darwin',
      inheritedEnv: {},
      darwinFallbackLocale: 'en_US.UTF-8',
    });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
  });
});

describe('computeUtf8SpawnEnv — win32', () => {
  it('sets PYTHONIOENCODING=utf-8 and does NOT set LANG/LC_ALL', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'win32',
      inheritedEnv: { PATH: 'C:\\Windows' },
    });
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect('LANG' in env).toBe(false);
    expect('LC_ALL' in env).toBe(false);
    expect(env.PATH).toBe('C:\\Windows');
  });

  it('UTF-8 contract OVERRIDES inherited PYTHONIOENCODING', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'win32',
      inheritedEnv: { PYTHONIOENCODING: 'latin-1' },
    });
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });
});

describe('UTF-8 contract key constants', () => {
  it('exposes POSIX contract keys', () => {
    expect(UTF8_CONTRACT_KEYS_POSIX).toEqual(['LANG', 'LC_ALL']);
  });
  it('exposes win32 contract keys', () => {
    expect(UTF8_CONTRACT_KEYS_WIN32).toEqual(['PYTHONIOENCODING']);
  });
});
