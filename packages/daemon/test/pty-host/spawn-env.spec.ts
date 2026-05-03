// Unit tests for the UTF-8 spawn env contract — spec ch06 §1.
//
// FOREVER-STABLE per spec; every assertion here corresponds to a single
// shall-statement so a future spec edit shows up as a single failing
// test name.

import { describe, expect, it } from 'vitest';

import {
  computeUtf8SpawnEnv,
  UTF8_CONTRACT_KEYS_POSIX,
  UTF8_CONTRACT_KEYS_WIN32,
} from '../../src/pty-host/spawn-env.js';

describe('computeUtf8SpawnEnv — linux', () => {
  it('sets LANG and LC_ALL to C.UTF-8 by default', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: {},
    });
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  it('overrides any inherited LANG / LC_ALL / LC_CTYPE values', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: {
        LANG: 'fr_FR.ISO-8859-1',
        LC_ALL: 'POSIX',
        LC_CTYPE: 'zh_CN.GBK',
      },
    });
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
    // LC_CTYPE is preserved (spec only pins LANG + LC_ALL); the host
    // glibc resolves the effective CTYPE from LC_ALL anyway.
    expect(env.LC_CTYPE).toBe('zh_CN.GBK');
  });

  it('does not set the Windows-only PYTHONIOENCODING key', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: {},
    });
    expect(env.PYTHONIOENCODING).toBeUndefined();
  });
});

describe('computeUtf8SpawnEnv — darwin', () => {
  it('sets LANG and LC_ALL to C.UTF-8 by default', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'darwin',
      inheritedEnv: {},
    });
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
  });

  it('honors darwinFallbackLocale when the daemon probe found en_US.UTF-8', () => {
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
  it('sets PYTHONIOENCODING=utf-8 by default', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'win32',
      inheritedEnv: {},
    });
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });

  it('overrides any inherited PYTHONIOENCODING value', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'win32',
      inheritedEnv: { PYTHONIOENCODING: 'latin-1' },
    });
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });

  it('does not set the POSIX-only LANG / LC_ALL keys', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'win32',
      inheritedEnv: {},
    });
    expect(env.LANG).toBeUndefined();
    expect(env.LC_ALL).toBeUndefined();
  });
});

describe('computeUtf8SpawnEnv — env precedence', () => {
  it('inherited env is the lowest precedence', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: { PATH: '/usr/bin', HOME: '/home/x', LANG: 'fr_FR.UTF-8' },
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    // contract overrides inherited
    expect(env.LANG).toBe('C.UTF-8');
  });

  it('envExtra overrides inherited but loses to UTF-8 contract', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: { PATH: '/usr/bin', LANG: 'fr_FR.UTF-8' },
      envExtra: { PATH: '/opt/bin', LANG: 'de_DE.UTF-8' },
    });
    expect(env.PATH).toBe('/opt/bin'); // envExtra > inherited
    expect(env.LANG).toBe('C.UTF-8');  // contract > envExtra
  });

  it('drops undefined inherited values (Node child_process refuses them)', () => {
    const env = computeUtf8SpawnEnv({
      platform: 'linux',
      inheritedEnv: { DEFINED: 'x', UNDEFINED: undefined },
    });
    expect(env.DEFINED).toBe('x');
    expect('UNDEFINED' in env).toBe(false);
  });
});

describe('contract key constants', () => {
  it('POSIX contract is exactly LANG + LC_ALL', () => {
    expect([...UTF8_CONTRACT_KEYS_POSIX].sort()).toEqual(['LANG', 'LC_ALL']);
  });

  it('Windows contract is exactly PYTHONIOENCODING', () => {
    expect([...UTF8_CONTRACT_KEYS_WIN32]).toEqual(['PYTHONIOENCODING']);
  });

  it('every POSIX contract key is set on linux + darwin', () => {
    for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
      const env = computeUtf8SpawnEnv({ platform, inheritedEnv: {} });
      for (const key of UTF8_CONTRACT_KEYS_POSIX) {
        expect(env[key], `${platform} should set ${key}`).toBeDefined();
      }
    }
  });

  it('every Windows contract key is set on win32', () => {
    const env = computeUtf8SpawnEnv({ platform: 'win32', inheritedEnv: {} });
    for (const key of UTF8_CONTRACT_KEYS_WIN32) {
      expect(env[key], `win32 should set ${key}`).toBeDefined();
    }
  });
});
