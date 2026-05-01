// T72 — double-bind guard tests.
//
// Coverage matrix:
//   - resolveControlSocketPath: drift guard against
//     daemon/src/sockets/control-socket.ts + runtime-root.ts
//     (same posture as tests/wait-daemon.test.ts §drift-guard).
//   - probeControlSocket: outcome variants (alive / absent / zombie) using
//     a fake connector — no real socket bind, deterministic.
//   - shouldSpawnDaemon: end-to-end decision wrapper, stderr capture.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import {
  probeControlSocket,
  resolveControlSocketPath,
  resolveDataRoot,
  resolveRuntimeRoot,
  shouldSpawnDaemon,
} from '../scripts/double-bind-guard.js';

// ---------------------------------------------------------------------------
// Fake socket: minimal `net.Socket` stand-in for `connect`/`error` events.
// ---------------------------------------------------------------------------
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
  emitConnectAsync(): void {
    setImmediate(() => this.emit('connect'));
  }
  emitErrorAsync(code: string, message = code): void {
    setImmediate(() => {
      const err = new Error(message) as NodeJS.ErrnoException;
      err.code = code;
      this.emit('error', err);
    });
  }
  emitNothing(): void {
    /* simulate wedged listener: never resolves */
  }
}

// ---------------------------------------------------------------------------
// resolveControlSocketPath drift guards.
// ---------------------------------------------------------------------------
describe('resolveDataRoot', () => {
  it('Linux: prefers XDG_DATA_HOME', () => {
    expect(
      resolveDataRoot('linux', { XDG_DATA_HOME: '/xdg/data' }),
    ).toBe('/xdg/data/ccsm');
  });
  it('Linux: falls back to ~/.local/share/ccsm', () => {
    const r = resolveDataRoot('linux', {});
    expect(r.endsWith('.local/share/ccsm') || r.endsWith('.local\\share\\ccsm')).toBe(true);
  });
  it('Windows: prefers LOCALAPPDATA', () => {
    expect(
      resolveDataRoot('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }),
    ).toBe('C:\\Users\\u\\AppData\\Local\\ccsm');
  });
  it('Windows: falls back to homedir AppData/Local/ccsm when LOCALAPPDATA missing', () => {
    const r = resolveDataRoot('win32', {});
    expect(r).toMatch(/AppData[\\/]Local[\\/]ccsm$/);
  });
  it('macOS: returns ~/Library/Application Support/ccsm', () => {
    const r = resolveDataRoot('darwin', {});
    expect(r).toMatch(/Library[\\/]Application Support[\\/]ccsm$/);
  });
});

describe('resolveRuntimeRoot', () => {
  it('Linux: uses XDG_RUNTIME_DIR if set', () => {
    expect(
      resolveRuntimeRoot('linux', {
        XDG_RUNTIME_DIR: '/run/user/1000',
        XDG_DATA_HOME: '/xdg/data',
      }),
    ).toBe('/run/user/1000/ccsm');
  });
  it('Linux: falls back to <dataRoot>/run', () => {
    expect(
      resolveRuntimeRoot('linux', { XDG_DATA_HOME: '/xdg/data' }),
    ).toBe('/xdg/data/ccsm/run');
  });
  it('macOS: <dataRoot>/run', () => {
    const r = resolveRuntimeRoot('darwin', {});
    expect(r).toMatch(/Library[\\/]Application Support[\\/]ccsm[\\/]run$/);
  });
  it('Windows: <dataRoot>\\run', () => {
    expect(
      resolveRuntimeRoot('win32', {
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Local\\ccsm\\run');
  });
});

describe('resolveControlSocketPath', () => {
  it('POSIX: <runtimeRoot>/ccsm-control.sock', () => {
    expect(
      resolveControlSocketPath('linux', {
        XDG_RUNTIME_DIR: '/run/user/1000',
      }),
    ).toBe('/run/user/1000/ccsm/ccsm-control.sock');
  });
  it('Windows: \\\\.\\pipe\\ccsm-control-<userhash>', () => {
    const got = resolveControlSocketPath('win32', {
      LOCALAPPDATA: 'C:\\x',
    });
    const ui = userInfo();
    const tag = `${ui.username}@${hostname()}`;
    const expectHash = createHash('sha256').update(tag).digest('hex').slice(0, 8);
    expect(got).toBe(`\\\\.\\pipe\\ccsm-control-${expectHash}`);
  });
});

// ---------------------------------------------------------------------------
// probeControlSocket outcome matrix.
// ---------------------------------------------------------------------------
describe('probeControlSocket', () => {
  it('hello-success path → kind=alive when connector emits connect', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      timeoutMs: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitConnectAsync();
    const out = await p;
    expect(out.kind).toBe('alive');
    expect(out.socketPath).toBe('/run/user/1000/ccsm/ccsm-control.sock');
    expect(sock.destroyed).toBe(true);
  });

  it('connect-refused → kind=absent (ECONNREFUSED)', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitErrorAsync('ECONNREFUSED');
    const out = await p;
    expect(out.kind).toBe('absent');
    if (out.kind === 'absent') {
      expect(out.reason).toBe('ECONNREFUSED');
    }
  });

  it('socket-not-found → kind=absent (ENOENT)', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitErrorAsync('ENOENT');
    const out = await p;
    expect(out.kind).toBe('absent');
    if (out.kind === 'absent') {
      expect(out.reason).toBe('ENOENT');
    }
  });

  it('hello-timeout (wedged listener) → kind=zombie', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 30,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitNothing();
    const out = await p;
    expect(out.kind).toBe('zombie');
    if (out.kind === 'zombie') {
      expect(out.reason).toMatch(/30ms/);
    }
    expect(sock.destroyed).toBe(true);
  });

  it('post-settle events do not flip outcome', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitConnectAsync();
    const out = await p;
    expect(out.kind).toBe('alive');
    // late error after settle: must not throw or change result
    sock.emit('error', Object.assign(new Error('late'), { code: 'EPIPE' }));
  });
});

// ---------------------------------------------------------------------------
// shouldSpawnDaemon decision wrapper.
// ---------------------------------------------------------------------------
describe('shouldSpawnDaemon', () => {
  let writes: string[];
  let origWrite: typeof process.stderr.write;
  beforeEach(() => {
    writes = [];
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  });
  afterEach(() => {
    process.stderr.write = origWrite;
  });

  it('returns false + logs "skipping" when daemon already alive', async () => {
    const sock = new FakeSocket();
    const p = shouldSpawnDaemon({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      timeoutMs: 100,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitConnectAsync();
    const proceed = await p;
    expect(proceed).toBe(false);
    expect(writes.join('')).toMatch(/already bound.*skipping spawn/);
  });

  it('returns true + logs "spawning" when no daemon present', async () => {
    const sock = new FakeSocket();
    const p = shouldSpawnDaemon({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 100,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitErrorAsync('ECONNREFUSED');
    const proceed = await p;
    expect(proceed).toBe(true);
    expect(writes.join('')).toMatch(/no daemon.*ECONNREFUSED.*spawning/);
  });

  it('returns true + logs WARN when listener is wedged', async () => {
    const sock = new FakeSocket();
    const p = shouldSpawnDaemon({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 30,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connector: () => sock as any,
    });
    sock.emitNothing();
    const proceed = await p;
    expect(proceed).toBe(true);
    expect(writes.join('')).toMatch(/WARN.*wedged.*spawning anyway/);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: re-import the daemon-side path computers and assert the
// dev-script mirrors them byte-for-byte across a representative matrix.
// Same posture as tests/wait-daemon.test.ts.
// ---------------------------------------------------------------------------
describe('drift guard against daemon/src/sockets/*', () => {
  it('matches defaultControlSocketPath across (platform, env) cases', async () => {
    const { defaultControlSocketPath } = await import(
      '../daemon/src/sockets/control-socket.js'
    );
    // We can't import resolveRuntimeRoot's full mkdir-side-effect impl here
    // because it touches the FS. Instead, inline the same input-only branches
    // by computing the expected runtimeRoot via our pure mirror, and feed
    // BOTH that path into defaultControlSocketPath() and compare.
    const cases: Array<{ platform: NodeJS.Platform; env: NodeJS.ProcessEnv }> = [
      { platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' } },
      { platform: 'linux', env: { XDG_DATA_HOME: '/xdg/data' } },
      { platform: 'darwin', env: {} },
      { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } },
    ];
    for (const { platform, env } of cases) {
      const ours = resolveControlSocketPath(platform, env);
      const theirs = defaultControlSocketPath(platform, resolveRuntimeRoot(platform, env));
      expect(ours).toBe(theirs);
    }
  });
});
