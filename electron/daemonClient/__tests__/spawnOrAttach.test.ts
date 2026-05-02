// Tests for spawnOrAttach (Task #103, frag-3.7 §3.7.2 + §3.7.4).

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  resolveDataRoot,
  resolveLockfilePath,
  spawnOrAttach,
} from '../spawnOrAttach';

describe('resolveDataRoot', () => {
  it('Linux: prefers XDG_DATA_HOME', () => {
    expect(
      resolveDataRoot({
        platform: 'linux',
        env: { XDG_DATA_HOME: '/srv/xdg' },
        home: '/home/u',
      }),
    ).toBe(path.join('/srv/xdg', 'ccsm'));
  });
  it('Linux: falls back to ~/.local/share when XDG_DATA_HOME unset', () => {
    expect(
      resolveDataRoot({ platform: 'linux', env: {}, home: '/home/u' }),
    ).toBe(path.join('/home/u', '.local', 'share', 'ccsm'));
  });
  it('Darwin: ~/Library/Application Support/ccsm', () => {
    expect(
      resolveDataRoot({ platform: 'darwin', env: {}, home: '/Users/u' }),
    ).toBe(path.join('/Users/u', 'Library', 'Application Support', 'ccsm'));
  });
  it('Win32: prefers LOCALAPPDATA', () => {
    expect(
      resolveDataRoot({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        home: 'C:\\Users\\u',
      }),
    ).toBe(path.join('C:\\Users\\u\\AppData\\Local', 'ccsm'));
  });
  it('Win32: falls back to %USERPROFILE%\\AppData\\Local', () => {
    expect(
      resolveDataRoot({
        platform: 'win32',
        env: {},
        home: 'C:\\Users\\u',
      }),
    ).toBe(path.join('C:\\Users\\u', 'AppData', 'Local', 'ccsm'));
  });
});

describe('resolveLockfilePath', () => {
  it('joins daemon.lock to dataRoot', () => {
    expect(
      resolveLockfilePath({
        platform: 'linux',
        env: { XDG_DATA_HOME: '/x' },
        home: '/h',
      }),
    ).toBe(path.join('/x', 'ccsm', 'daemon.lock'));
  });
});

describe('spawnOrAttach', () => {
  it('returns "attached" when lockfile exists', () => {
    const result = spawnOrAttach({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/srv/xdg' },
      home: '/home/u',
      lockfileExists: () => true,
    });
    expect(result.kind).toBe('attached');
    expect(result.lockfilePath).toBe(
      path.join('/srv/xdg', 'ccsm', 'daemon.lock'),
    );
  });

  it('returns "dev-no-spawn" when lockfile missing AND CCSM_DAEMON_DEV=1', () => {
    const result = spawnOrAttach({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/srv/xdg', CCSM_DAEMON_DEV: '1' },
      home: '/home/u',
      lockfileExists: () => false,
    });
    expect(result.kind).toBe('dev-no-spawn');
  });

  it('returns "dev-no-spawn" with explicit dev=true even if env is unset', () => {
    const result = spawnOrAttach({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/srv/xdg' },
      home: '/home/u',
      lockfileExists: () => false,
      dev: true,
    });
    expect(result.kind).toBe('dev-no-spawn');
  });

  it('returns "spawned" in prod when spawnDaemonFn provided', () => {
    const fakeChild = { pid: 9999, unref: (): void => undefined } as unknown as ReturnType<
      NonNullable<Parameters<typeof spawnOrAttach>[0]>['spawnDaemonFn']
    > extends infer C
      ? C extends null
        ? never
        : C
      : never;
    const result = spawnOrAttach({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/srv/xdg' },
      home: '/home/u',
      lockfileExists: () => false,
      dev: false,
      spawnDaemonFn: () => fakeChild,
    });
    expect(result.kind).toBe('spawned');
    if (result.kind === 'spawned') {
      expect(result.pid).toBe(9999);
    }
  });

  it('returns "dev-no-spawn" when prod but spawnDaemonFn yields null', () => {
    const result = spawnOrAttach({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/srv/xdg' },
      home: '/home/u',
      lockfileExists: () => false,
      dev: false,
      spawnDaemonFn: () => null,
    });
    expect(result.kind).toBe('dev-no-spawn');
  });

  it('returns "dev-no-spawn" in prod when no spawn fn injected', () => {
    const result = spawnOrAttach({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/srv/xdg' },
      home: '/home/u',
      lockfileExists: () => false,
      dev: false,
    });
    expect(result.kind).toBe('dev-no-spawn');
  });

  it('propagates non-ENOENT fs errors from the existence check', () => {
    expect(() =>
      spawnOrAttach({
        platform: 'linux',
        env: { XDG_DATA_HOME: '/srv/xdg' },
        home: '/home/u',
        lockfileExists: () => {
          const e = new Error('permission denied') as NodeJS.ErrnoException;
          e.code = 'EACCES';
          throw e;
        },
      }),
    ).toThrow(/permission denied/);
  });
});
