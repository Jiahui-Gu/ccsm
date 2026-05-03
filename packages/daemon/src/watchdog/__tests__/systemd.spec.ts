// Unit tests for `startSystemdWatchdog`. Cover the four behavior axes:
//   1. non-Linux platform → no-op (handle.isActive() === false)
//   2. Linux + NOTIFY_SOCKET unset → no-op
//   3. Linux + NOTIFY_SOCKET set → spawns `systemd-notify WATCHDOG=1`
//      immediately AND every 10s thereafter (fake timers)
//   4. systemd-notify missing on PATH → logs once, never again, never
//      crashes the daemon
//
// Spec: ch09 §6, ch02 §2.3 — see `../systemd.ts` header.
//
// We do NOT spawn a real `systemd-notify` here — the indirection seam
// (`SystemdWatchdogDeps.spawn`) lets us count calls deterministically.
// A real-systemd integration test (gated by `existsSync('/run/systemd/system')`)
// lives in `packages/daemon/test/integration/watchdog-linux.spec.ts` per
// spec ch09 §6 last paragraph.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startSystemdWatchdog,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_SEC_DIRECTIVE,
  type SystemdWatchdogDeps,
} from '../systemd.js';

// ---------------------------------------------------------------------------
// Fake spawn — returns a minimal ChildProcess-shaped EventEmitter so the
// production code's `.on('error', ...)` wiring works without launching a
// real subprocess.
// ---------------------------------------------------------------------------

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
}

function makeFakeSpawn(opts: {
  readonly emitErrorCode?: string | null;
} = {}): { spawn: SystemdWatchdogDeps['spawn']; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args: [...args] });
    const child = new EventEmitter() as EventEmitter & {
      stdout?: null;
      stderr?: null;
    };
    if (opts.emitErrorCode) {
      // Defer the error emit so the caller has a chance to attach the
      // listener — matches real ChildProcess semantics.
      void Promise.resolve().then(() => {
        const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        err.code = opts.emitErrorCode!;
        child.emit('error', err);
      });
    }
    return child as never;
  }) as unknown as SystemdWatchdogDeps['spawn'];
  return { spawn, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startSystemdWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the locked cadence constants', () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(10_000);
    // Three ticks of headroom — see ch02 §2.3 unit-file directive.
    expect(WATCHDOG_SEC_DIRECTIVE).toBe(30);
    expect(WATCHDOG_SEC_DIRECTIVE).toBeGreaterThanOrEqual(
      (WATCHDOG_INTERVAL_MS * 3) / 1000,
    );
  });

  it('is a no-op on non-Linux platforms (mac/win/dev)', () => {
    const fake = makeFakeSpawn();
    const handle = startSystemdWatchdog({
      platform: 'darwin',
      notifySocket: '/tmp/whatever.sock',
      spawn: fake.spawn,
    });
    try {
      expect(handle.isActive()).toBe(false);
      // No tick attempted, even after the interval elapses.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
      expect(fake.calls.length).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('is a no-op on Linux when NOTIFY_SOCKET is unset', () => {
    const fake = makeFakeSpawn();
    const handle = startSystemdWatchdog({
      platform: 'linux',
      notifySocket: undefined,
      spawn: fake.spawn,
    });
    try {
      expect(handle.isActive()).toBe(false);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
      expect(fake.calls.length).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('is a no-op on Linux when NOTIFY_SOCKET is empty string', () => {
    const fake = makeFakeSpawn();
    const handle = startSystemdWatchdog({
      platform: 'linux',
      notifySocket: '',
      spawn: fake.spawn,
    });
    try {
      expect(handle.isActive()).toBe(false);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 3);
      expect(fake.calls.length).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('on Linux with NOTIFY_SOCKET set, fires WATCHDOG=1 immediately and every 10s', () => {
    const fake = makeFakeSpawn();
    const handle = startSystemdWatchdog({
      platform: 'linux',
      notifySocket: '/run/systemd/notify',
      spawn: fake.spawn,
    });
    try {
      expect(handle.isActive()).toBe(true);
      // First tick is synchronous.
      expect(fake.calls.length).toBe(1);
      expect(fake.calls[0]).toEqual({
        cmd: 'systemd-notify',
        args: ['WATCHDOG=1'],
      });

      // Three more ticks at 10s cadence.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(fake.calls.length).toBe(2);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(fake.calls.length).toBe(3);
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      expect(fake.calls.length).toBe(4);

      for (const call of fake.calls) {
        expect(call).toEqual({ cmd: 'systemd-notify', args: ['WATCHDOG=1'] });
      }
    } finally {
      handle.stop();
    }
  });

  it('stop() halts subsequent ticks and is idempotent', () => {
    const fake = makeFakeSpawn();
    const handle = startSystemdWatchdog({
      platform: 'linux',
      notifySocket: '/run/systemd/notify',
      spawn: fake.spawn,
    });
    expect(fake.calls.length).toBe(1); // initial tick
    handle.stop();
    expect(handle.isActive()).toBe(false);
    vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS * 5);
    expect(fake.calls.length).toBe(1); // unchanged after stop
    // Idempotent — second call is a no-op.
    handle.stop();
    handle.stop();
    expect(fake.calls.length).toBe(1);
  });

  it('logs once when systemd-notify is missing on PATH (ENOENT), no spam thereafter', async () => {
    const fake = makeFakeSpawn({ emitErrorCode: 'ENOENT' });
    const logs: string[] = [];
    const handle = startSystemdWatchdog({
      platform: 'linux',
      notifySocket: '/run/systemd/notify',
      spawn: fake.spawn,
      log: (line) => logs.push(line),
    });
    try {
      // Initial tick spawned + queued an ENOENT — drain microtasks so the
      // 'error' event fires.
      await Promise.resolve();
      await Promise.resolve();
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatch(/systemd watchdog/i);
      expect(logs[0]).toMatch(/ENOENT/);

      // Subsequent ticks also fail, but log stays at 1.
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(WATCHDOG_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      expect(fake.calls.length).toBe(3); // we kept trying — that is intentional
      expect(logs.length).toBe(1); // but only logged once
    } finally {
      handle.stop();
    }
  });

  it('does not crash when spawn() itself throws synchronously', () => {
    const logs: string[] = [];
    const throwingSpawn = (() => {
      throw new Error('synthetic spawn failure');
    }) as unknown as SystemdWatchdogDeps['spawn'];
    expect(() =>
      startSystemdWatchdog({
        platform: 'linux',
        notifySocket: '/run/systemd/notify',
        spawn: throwingSpawn,
        log: (line) => logs.push(line),
      }),
    ).not.toThrow();
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/spawn failed/i);
  });
});
