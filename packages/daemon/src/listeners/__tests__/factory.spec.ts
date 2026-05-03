// Spec for the Listener A factory — `makeListenerA(env)`. Covers spec
// ch03 §1 (Listener trait lifecycle: start once / stop idempotent /
// descriptor only after start) and §2 (factory shape).
//
// Real-socket assertions: we exercise the `defaultBindHook` end-to-end
// for `loopbackTcp` (works on every platform) and for `uds` on POSIX
// (skipped on win32 where UDS path semantics differ — the named-pipe
// branch is exercised via `BindHook` injection on every host).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LISTENER_A_ID,
  defaultBindHook,
  makeListenerA,
  type BindHook,
  type BoundTransport,
} from '../factory.js';
import type { DaemonEnv } from '../../env.js';
import { RESERVED_FOR_LISTENER_B } from '../../env.js';
import type { BindDescriptor } from '../types.js';

const POSIX = process.platform !== 'win32';

function envWith(listenerAddr: string): DaemonEnv {
  return {
    mode: 'dev',
    paths: {
      stateDir: '/tmp/ccsm-state',
      descriptorPath: '/tmp/ccsm-state/listener-a.json',
      listenerAddr,
      supervisorAddr: '/tmp/ccsm-state/supervisor.sock',
    },
    listeners: [null, RESERVED_FOR_LISTENER_B] as const,
    bootId: '550e8400-e29b-41d4-a716-446655440000',
    version: '0.3.0-dev',
    buildCommit: 'dev',
  };
}

/** A minimal `BindHook` that records the descriptor it was called with
 * and returns a fake `BoundTransport`. Used to exercise the factory's
 * trait wiring without touching real sockets (so tests pass on every
 * platform). */
function fakeHook(): BindHook & { calls: BindDescriptor[]; stops: number } {
  const calls: BindDescriptor[] = [];
  let stops = 0;
  const hook = (async (descriptor: BindDescriptor): Promise<BoundTransport> => {
    calls.push(descriptor);
    // For loopback, simulate the OS assigning a real port if input was 0.
    const resolved: BindDescriptor =
      descriptor.kind === 'KIND_TCP_LOOPBACK_H2C' && descriptor.port === 0
        ? { kind: 'KIND_TCP_LOOPBACK_H2C', host: descriptor.host, port: 49152 }
        : descriptor;
    return {
      descriptor: resolved,
      async stop() {
        stops += 1;
      },
    };
  }) as BindHook & { calls: BindDescriptor[]; stops: number };
  Object.defineProperty(hook, 'calls', { value: calls });
  Object.defineProperty(hook, 'stops', {
    get(): number {
      return stops;
    },
  });
  return hook;
}

describe('makeListenerA — trait shape (T1.2 contract)', () => {
  it('returns a Listener with the canonical id', () => {
    const env = envWith('/tmp/x.sock');
    const listener = makeListenerA(env, {
      bindHook: fakeHook(),
      platform: 'linux',
    });
    expect(listener.id).toBe(LISTENER_A_ID);
    expect(listener.id).toBe('listener-a');
  });

  it('start() then descriptor() returns the resolved descriptor', async () => {
    const env = envWith('/tmp/y.sock');
    const hook = fakeHook();
    const listener = makeListenerA(env, { bindHook: hook, platform: 'linux' });
    await listener.start();
    expect(listener.descriptor()).toEqual({ kind: 'KIND_UDS', path: '/tmp/y.sock' });
    expect(hook.calls).toHaveLength(1);
    await listener.stop();
  });

  it('descriptor() before start() throws (programming error per spec ch03 §1)', () => {
    const env = envWith('/tmp/z.sock');
    const listener = makeListenerA(env, {
      bindHook: fakeHook(),
      platform: 'linux',
    });
    expect(() => listener.descriptor()).toThrow(/before start/);
  });

  it('start() twice throws (idempotent-fail per spec ch03 §1)', async () => {
    const env = envWith('/tmp/a.sock');
    const listener = makeListenerA(env, {
      bindHook: fakeHook(),
      platform: 'linux',
    });
    await listener.start();
    await expect(listener.start()).rejects.toThrow(/start\(\) called twice/);
    await listener.stop();
  });

  it('stop() before start() is a no-op (idempotent per spec ch03 §1)', async () => {
    const env = envWith('/tmp/b.sock');
    const hook = fakeHook();
    const listener = makeListenerA(env, { bindHook: hook, platform: 'linux' });
    await expect(listener.stop()).resolves.toBeUndefined();
    expect(hook.stops).toBe(0);
  });

  it('stop() twice is a no-op on the second call', async () => {
    const env = envWith('/tmp/c.sock');
    const hook = fakeHook();
    const listener = makeListenerA(env, { bindHook: hook, platform: 'linux' });
    await listener.start();
    await listener.stop();
    await listener.stop();
    expect(hook.stops).toBe(1);
  });
});

describe('makeListenerA — transport pick wiring (per-OS)', () => {
  it('linux: pick is forwarded to bindHook as kind=uds', async () => {
    const env = envWith('/tmp/uds-linux.sock');
    const hook = fakeHook();
    await makeListenerA(env, { bindHook: hook, platform: 'linux' }).start();
    expect(hook.calls[0]).toEqual({ kind: 'KIND_UDS', path: '/tmp/uds-linux.sock' });
  });

  it('darwin: pick is forwarded to bindHook as kind=uds', async () => {
    const env = envWith('/var/run/com.ccsm.daemon/daemon.sock');
    const hook = fakeHook();
    await makeListenerA(env, { bindHook: hook, platform: 'darwin' }).start();
    expect(hook.calls[0]).toEqual({
      kind: 'KIND_UDS',
      path: '/var/run/com.ccsm.daemon/daemon.sock',
    });
  });

  it('win32: pick is forwarded to bindHook as kind=namedPipe', async () => {
    const env = envWith('\\\\.\\pipe\\ccsm-daemon');
    const hook = fakeHook();
    await makeListenerA(env, { bindHook: hook, platform: 'win32' }).start();
    expect(hook.calls[0]).toEqual({
      kind: 'KIND_NAMED_PIPE',
      pipeName: '\\\\.\\pipe\\ccsm-daemon',
    });
  });

  it('CCSM_LISTENER_A_FORCE_LOOPBACK=1: pick becomes loopbackTcp with ephemeral port', async () => {
    const saved = process.env.CCSM_LISTENER_A_FORCE_LOOPBACK;
    process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = '1';
    try {
      const env = envWith('/tmp/ignored.sock');
      const hook = fakeHook();
      await makeListenerA(env, { bindHook: hook, platform: 'linux' }).start();
      expect(hook.calls[0]).toEqual({
        kind: 'KIND_TCP_LOOPBACK_H2C',
        host: '127.0.0.1',
        port: 0,
      });
    } finally {
      if (saved === undefined) delete process.env.CCSM_LISTENER_A_FORCE_LOOPBACK;
      else process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = saved;
    }
  });
});

describe('makeListenerA — start() failure surfacing', () => {
  it('start() rejects when bindHook rejects', async () => {
    const env = envWith('/tmp/fail.sock');
    const failHook: BindHook = async () => {
      throw new Error('bind failed: EADDRINUSE');
    };
    const listener = makeListenerA(env, {
      bindHook: failHook,
      platform: 'linux',
    });
    await expect(listener.start()).rejects.toThrow(/EADDRINUSE/);
    // Per spec ch03 §1 stop() is safe after a failed start().
    await expect(listener.stop()).resolves.toBeUndefined();
  });
});

describe('defaultBindHook — loopbackTcp end-to-end', () => {
  it('binds an ephemeral port and resolves the descriptor with the real port', async () => {
    const bound = await defaultBindHook({
      kind: 'KIND_TCP_LOOPBACK_H2C',
      host: '127.0.0.1',
      port: 0,
    });
    try {
      expect(bound.descriptor.kind).toBe('KIND_TCP_LOOPBACK_H2C');
      if (bound.descriptor.kind === 'KIND_TCP_LOOPBACK_H2C') {
        expect(bound.descriptor.host).toBe('127.0.0.1');
        expect(bound.descriptor.port).toBeGreaterThan(0);
        expect(bound.descriptor.port).not.toBe(0);
      }
    } finally {
      await bound.stop();
    }
  });

  it('stop() is idempotent', async () => {
    const bound = await defaultBindHook({
      kind: 'KIND_TCP_LOOPBACK_H2C',
      host: '127.0.0.1',
      port: 0,
    });
    await bound.stop();
    await expect(bound.stop()).resolves.toBeUndefined();
  });
});

describe.skipIf(!POSIX)('defaultBindHook — uds end-to-end (POSIX only)', () => {
  let dir: string;
  let sockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccsm-listener-a-'));
    sockPath = join(dir, 'daemon.sock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('binds a UDS at the given path', async () => {
    const bound = await defaultBindHook({ kind: 'KIND_UDS', path: sockPath });
    try {
      expect(bound.descriptor).toEqual({ kind: 'KIND_UDS', path: sockPath });
      const st = await stat(sockPath);
      // Different OS / FS report `isSocket()` differently — what
      // matters is that something exists at the path post-bind.
      expect(st).toBeDefined();
    } finally {
      await bound.stop();
    }
  });

  it('removes a stale leftover socket file before bind (no EADDRINUSE)', async () => {
    // Simulate a crashed-daemon leftover with an arbitrary file at the
    // path; a real UDS file or a regular file both block `bind(2)` with
    // EADDRINUSE on POSIX, so the cleanup must handle both.
    await writeFile(sockPath, 'leftover');
    const bound = await defaultBindHook({ kind: 'KIND_UDS', path: sockPath });
    try {
      expect(bound.descriptor).toEqual({ kind: 'KIND_UDS', path: sockPath });
    } finally {
      await bound.stop();
    }
  });
});
