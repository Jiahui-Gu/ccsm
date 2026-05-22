import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { spawn as spawnFn } from 'node:child_process';

// Hoist the spawn spy so vi.mock's factory (also hoisted) closes over the
// same reference the tests assert against.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  // Re-export the few symbols transitively touched by the runtime to keep
  // unrelated imports happy. Anything else throws — these tests don't need
  // it, and the production code under test only uses `spawn`.
  default: { spawn: spawnMock },
}));

import { killProcessSubtree, TASKKILL_TIMEOUT_MS } from '../processKiller';

/** A minimal stand-in for ChildProcess that exposes `once('exit'|'error')`
 *  + `kill()` — enough for processKiller to drive its resolve/timeout race. */
function makeFakeChild() {
  const ee = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    once: (e: string, cb: (...a: unknown[]) => void) => EventEmitter;
  };
  ee.kill = vi.fn();
  return ee;
}

describe('killProcessSubtree — guards', () => {
  // No spawn / no process.kill should be invoked for invalid pids.
  it.each([
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -1],
  ])('no-op for %s pid (resolves immediately)', async (_label, pid) => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      await expect(killProcessSubtree(pid as number | undefined)).resolves.toBeUndefined();
      expect(killSpy).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('killProcessSubtree — windows path (async spawn)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.useRealTimers();
  });

  it('invokes taskkill with /F /T /PID <pid> and windowsHide', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawnFn>);
    const promise = killProcessSubtree(4242);
    // Caller should have invoked spawn synchronously with the canonical args.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/T', '/PID', '4242'],
      expect.objectContaining({ windowsHide: true, stdio: 'ignore' }),
    );
    // Promise hasn't resolved yet — waiting on taskkill exit.
    // Fire exit; promise should resolve.
    child.emit('exit', 0, null);
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves on child error (taskkill binary missing / spawn ENOENT)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawnFn>);
    const promise = killProcessSubtree(7);
    child.emit('error', new Error('ENOENT'));
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves on a synchronous spawn throw (also no leak)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn blew up');
    });
    // No `unhandledRejection` — the promise resolves cleanly.
    await expect(killProcessSubtree(11)).resolves.toBeUndefined();
  });

  it('resolves after TASKKILL_TIMEOUT_MS if exit never fires (wedged taskkill)', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawnFn>);
    const promise = killProcessSubtree(99);
    let resolved = false;
    void promise.then(() => { resolved = true; });
    // Before the timeout: promise still pending.
    await Promise.resolve(); // let microtasks drain
    expect(resolved).toBe(false);
    // Advance just under the timeout — still pending.
    vi.advanceTimersByTime(TASKKILL_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Cross the timeout boundary — promise resolves; child.kill() called as
    // a last-ditch attempt to free the wedged taskkill handle.
    vi.advanceTimersByTime(1);
    await promise;
    expect(resolved).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  it('parallel kills do not serialize on each other (Promise.all stays cheap)', async () => {
    // Stub each spawn with its own EE — none of them resolve until we say so.
    const children: ReturnType<typeof makeFakeChild>[] = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c as unknown as ReturnType<typeof spawnFn>;
    });
    const all = Promise.all([
      killProcessSubtree(1),
      killProcessSubtree(2),
      killProcessSubtree(3),
    ]);
    // All three taskkills were dispatched synchronously — none waited on
    // the previous one. This is the property the old `spawnSync` path
    // violated and the bug fix protects.
    expect(spawnMock).toHaveBeenCalledTimes(3);
    children.forEach((c) => c.emit('exit', 0, null));
    await expect(all).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('does not invoke process.kill on win32 (uses taskkill instead)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawnFn>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      const p = killProcessSubtree(999999);
      child.emit('exit', 1, null);
      await p;
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('killProcessSubtree — posix path', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.useFakeTimers();
    spawnMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.useRealTimers();
  });

  it('signals process group SIGTERM, then SIGKILL after 500ms; resolves immediately', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      const promise = killProcessSubtree(4321);

      // Immediate SIGTERM to negative pid (process group)
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledTimes(1);

      // Promise resolves without needing the SIGKILL timer to fire — POSIX
      // path is non-blocking, so we don't make callers wait 500ms on quit.
      await expect(promise).resolves.toBeUndefined();

      // Advance timers — SIGKILL still fires for the actual process.
      vi.advanceTimersByTime(500);
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
      expect(killSpy).toHaveBeenCalledTimes(2);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does not spawn taskkill on linux', async () => {
    vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    await killProcessSubtree(123);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('swallows SIGTERM throw (group already gone) and still schedules SIGKILL', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => {
      throw new Error('ESRCH');
    }) as never);
    try {
      await expect(killProcessSubtree(7)).resolves.toBeUndefined();
      // SIGKILL after timeout should also be swallowed
      expect(() => vi.advanceTimersByTime(500)).not.toThrow();
      // Both attempts were made
      expect(killSpy).toHaveBeenCalledWith(-7, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-7, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
    }
  });
});
