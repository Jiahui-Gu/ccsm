import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock node:child_process via vi.hoisted so production code and test
// assertions share the SAME `vi.fn()` reference. vi.spyOn(ns,'spawn')
// doesn't work under vitest's ESM module namespace (non-configurable
// exports), so we intercept at the module-resolution layer instead.
const cp = vi.hoisted(() => {
  return { spawn: vi.fn() };
});
vi.mock('node:child_process', () => ({
  default: { spawn: cp.spawn },
  spawn: cp.spawn,
}));

import { killProcessSubtree, TASKKILL_TIMEOUT_MS } from '../processKiller';

/** Fake taskkill child with the `.kill()` + 'close'/'error' surface
 *  killProcessSubtree consumes. Mirrors node `ChildProcess` enough for
 *  the production code path; not a full implementation. */
type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };
function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.kill = vi.fn();
  return ee;
}

describe('killProcessSubtree — guards', () => {
  beforeEach(() => {
    cp.spawn.mockReset();
  });

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
      expect(cp.spawn).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('killProcessSubtree — windows path (async taskkill)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    cp.spawn.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('spawns taskkill /F /T /PID asynchronously (does NOT block on spawnSync)', () => {
    const fake = makeFakeChild();
    cp.spawn.mockReturnValue(fake);
    // Don't await — proves the function returns a pending Promise before
    // taskkill actually exits (the regression spawnSync would have blocked).
    const p = killProcessSubtree(1234);
    expect(cp.spawn).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/T', '/PID', '1234'],
      expect.objectContaining({ windowsHide: true, stdio: 'ignore' }),
    );
    expect(p).toBeInstanceOf(Promise);
    // Drive the fake child to close so the Promise resolves before the
    // test finishes (otherwise the timer would unref-await for 5s).
    fake.emit('close', 0);
    return p;
  });

  it('resolves when taskkill emits close', async () => {
    const fake = makeFakeChild();
    cp.spawn.mockReturnValue(fake);
    const p = killProcessSubtree(42);
    fake.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves when taskkill emits error (e.g. ENOENT — binary missing)', async () => {
    const fake = makeFakeChild();
    cp.spawn.mockReturnValue(fake);
    const p = killProcessSubtree(42);
    fake.emit('error', new Error('ENOENT'));
    await expect(p).resolves.toBeUndefined();
  });

  it('5s ceiling: timer fires child.kill() and resolves if taskkill wedges', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeChild();
      cp.spawn.mockReturnValue(fake);
      const p = killProcessSubtree(42);

      // Just before the ceiling, still pending.
      let resolved = false;
      void p.then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(TASKKILL_TIMEOUT_MS - 50);
      expect(resolved).toBe(false);
      expect(fake.kill).not.toHaveBeenCalled();

      // Cross the ceiling: last-ditch kill fires AND the Promise resolves
      // so the surrounding quit path can proceed.
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.kill).toHaveBeenCalledTimes(1);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows synchronous spawn throw (e.g. EACCES) and resolves', async () => {
    cp.spawn.mockImplementation(() => {
      throw new Error('EACCES');
    });
    await expect(killProcessSubtree(42)).resolves.toBeUndefined();
  });

  it('does not invoke process.kill on win32 (uses taskkill instead)', async () => {
    const fake = makeFakeChild();
    cp.spawn.mockReturnValue(fake);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      const p = killProcessSubtree(999999);
      fake.emit('close', 0);
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
    cp.spawn.mockReset();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.useFakeTimers();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.useRealTimers();
  });

  it('signals process group SIGTERM, then SIGKILL after 500ms, resolves immediately', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      const p = killProcessSubtree(4321);

      // Immediate SIGTERM to negative pid (process group)
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledTimes(1);

      // The returned Promise resolves immediately (POSIX path doesn't
      // wait on the SIGKILL escalation — that's a fire-and-forget timer
      // so the quit path can proceed without sitting on a 500ms delay
      // for every session).
      await expect(p).resolves.toBeUndefined();

      // Advance timers — SIGKILL should fire
      vi.advanceTimersByTime(500);
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
      expect(killSpy).toHaveBeenCalledTimes(2);
    } finally {
      killSpy.mockRestore();
    }
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
