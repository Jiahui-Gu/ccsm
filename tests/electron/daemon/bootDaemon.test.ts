// tests/electron/daemon/bootDaemon.test.ts
//
// v0.3 Task 4 (frag-6-7 §6.1) — Electron-main boot wire for spawnDaemon().
//
// Covers the decision tree:
//   - dev short-circuit (CCSM_DAEMON_DEV=1 → no spawn)
//   - alive socket → no spawn (double-bind guard / re-attach)
//   - absent socket + packaged → spawn detached
//   - absent socket + unpackaged + no dev env → skip (no binary)
//   - zombie socket → spawn anyway (best-effort)
//   - resolveDaemonBinary path shape (Win / POSIX)
// Plus a drift guard pinning resolveControlSocketPath against the daemon
// implementation (mirrors tests/double-bind-guard.test.ts §drift-guard).

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  bootDaemon,
  probeControlSocket,
  resolveControlSocketPath,
  resolveDaemonBinary,
  resolveRuntimeRoot,
} from '../../../electron/daemon/bootDaemon';

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

function fakeSpawnHandle(): { fn: any; calls: any[] } {
  const calls: any[] = [];
  const fn = (opts: any) => {
    calls.push(opts);
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    return child;
  };
  return { fn, calls };
}

describe('bootDaemon decision tree', () => {
  it('CCSM_DAEMON_DEV=1 → skipped-dev (no probe, no spawn)', async () => {
    const probe = vi.fn();
    const spawn = vi.fn();
    const logs: string[] = [];
    const out = await bootDaemon({
      isPackaged: true,
      resourcesPath: '/fake/resources',
      env: { CCSM_DAEMON_DEV: '1' },
      probe: probe as any,
      spawn: spawn as any,
      log: (l) => logs.push(l),
    });
    expect(out).toEqual({ kind: 'skipped-dev' });
    expect(probe).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/CCSM_DAEMON_DEV=1.*nodemon/);
  });

  it('alive socket → skipped-already-alive (no spawn)', async () => {
    const probe = vi.fn().mockResolvedValue({ kind: 'alive', socketPath: '/tmp/sock' });
    const spawn = vi.fn();
    const out = await bootDaemon({
      isPackaged: true,
      resourcesPath: '/fake/resources',
      env: {},
      probe: probe as any,
      spawn: spawn as any,
      log: () => {},
    });
    expect(out).toEqual({ kind: 'skipped-already-alive', socketPath: '/tmp/sock' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('absent socket + packaged → spawned (detached, unref called)', async () => {
    const probe = vi.fn().mockResolvedValue({
      kind: 'absent', socketPath: '/tmp/sock', reason: 'ENOENT',
    });
    const { fn: spawnFn, calls } = fakeSpawnHandle();
    const out = await bootDaemon({
      isPackaged: true,
      resourcesPath: '/fake/resources',
      env: {},
      probe: probe as any,
      spawn: spawnFn as any,
      log: () => {},
    });
    expect(out.kind).toBe('spawned');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.binary).toMatch(/[\\/]fake[\\/]resources[\\/]daemon[\\/]ccsm-daemon/);
    expect(calls[0]!.spawnOptions.detached).toBe(true);
    expect(calls[0]!.spawnOptions.stdio).toBe('ignore');
    expect(calls[0]!.spawnOptions.windowsHide).toBe(true);
  });

  it('absent socket + unpackaged + no dev env → skipped-no-binary', async () => {
    const probe = vi.fn().mockResolvedValue({
      kind: 'absent', socketPath: '/tmp/sock', reason: 'ENOENT',
    });
    const spawn = vi.fn();
    const out = await bootDaemon({
      isPackaged: false,
      resourcesPath: '',
      env: {},
      probe: probe as any,
      spawn: spawn as any,
      log: () => {},
    });
    expect(out.kind).toBe('skipped-no-binary');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('zombie socket → spawn anyway (best-effort, log WARN)', async () => {
    const probe = vi.fn().mockResolvedValue({
      kind: 'zombie', socketPath: '/tmp/sock', reason: 'no connect verdict within 500ms',
    });
    const { fn: spawnFn, calls } = fakeSpawnHandle();
    const logs: string[] = [];
    const out = await bootDaemon({
      isPackaged: true,
      resourcesPath: '/fake/resources',
      env: {},
      probe: probe as any,
      spawn: spawnFn as any,
      log: (l) => logs.push(l),
    });
    expect(out.kind).toBe('spawned');
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/WARN.*wedged.*spawning anyway/);
  });

  it('spawn throws → spawn-failed (does not propagate)', async () => {
    const probe = vi.fn().mockResolvedValue({
      kind: 'absent', socketPath: '/tmp/sock', reason: 'ENOENT',
    });
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT spawn ccsm-daemon');
    });
    const out = await bootDaemon({
      isPackaged: true,
      resourcesPath: '/fake/resources',
      env: {},
      probe: probe as any,
      spawn: spawn as any,
      log: () => {},
    });
    expect(out.kind).toBe('spawn-failed');
    if (out.kind === 'spawn-failed') {
      expect(out.reason).toMatch(/ENOENT/);
    }
  });
});

describe('resolveDaemonBinary', () => {
  it('Windows packaged: <resources>/daemon/ccsm-daemon.exe', () => {
    const got = resolveDaemonBinary({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\ccsm\\resources',
      platform: 'win32',
    });
    expect(got).toMatch(/ccsm-daemon\.exe$/);
    expect(got).toContain('daemon');
  });
  it('macOS packaged: <resources>/daemon/ccsm-daemon (no ext)', () => {
    const got = resolveDaemonBinary({
      isPackaged: true,
      resourcesPath: '/Applications/CCSM.app/Contents/Resources',
      platform: 'darwin',
    });
    expect(got).toBe('/Applications/CCSM.app/Contents/Resources/daemon/ccsm-daemon');
  });
  it('Linux packaged: <resources>/daemon/ccsm-daemon', () => {
    const got = resolveDaemonBinary({
      isPackaged: true,
      resourcesPath: '/opt/ccsm/resources',
      platform: 'linux',
    });
    expect(got).toBe('/opt/ccsm/resources/daemon/ccsm-daemon');
  });
  it('unpackaged returns null', () => {
    expect(
      resolveDaemonBinary({ isPackaged: false, resourcesPath: '', platform: 'linux' }),
    ).toBeNull();
  });
});

describe('probeControlSocket (smoke; full matrix lives in tests/double-bind-guard.test.ts mirror)', () => {
  it('connect → alive', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      timeoutMs: 100,
      connector: () => sock as any,
    });
    setImmediate(() => sock.emit('connect'));
    const out = await p;
    expect(out.kind).toBe('alive');
    expect(out.socketPath).toBe('/run/user/1000/ccsm/ccsm-control.sock');
    expect(sock.destroyed).toBe(true);
  });

  it('error → absent with err.code reason', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 100,
      connector: () => sock as any,
    });
    setImmediate(() => {
      const err = new Error('boom') as NodeJS.ErrnoException;
      err.code = 'ECONNREFUSED';
      sock.emit('error', err);
    });
    const out = await p;
    expect(out.kind).toBe('absent');
    if (out.kind === 'absent') expect(out.reason).toBe('ECONNREFUSED');
  });

  it('no event → zombie after timeout', async () => {
    const sock = new FakeSocket();
    const p = probeControlSocket({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/xdg' },
      timeoutMs: 20,
      connector: () => sock as any,
    });
    const out = await p;
    expect(out.kind).toBe('zombie');
  });
});

describe('drift guard against daemon/src/sockets/* (mirror)', () => {
  it('matches defaultControlSocketPath across (platform, env) cases', async () => {
    const { defaultControlSocketPath } = await import(
      '../../../daemon/src/sockets/control-socket.js'
    );
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
