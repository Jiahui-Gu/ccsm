import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { killProcessSubtree } from '../processKiller';

describe('killProcessSubtree — guards', () => {
  // No spawn / no process.kill should be invoked for invalid pids.
  it.each([
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -1],
  ])('no-op for %s pid', (_label, pid) => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      // Should not throw and not signal anything.
      expect(() => killProcessSubtree(pid as number | undefined)).not.toThrow();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('killProcessSubtree — windows path', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('does not throw for a non-existent pid (taskkill swallows)', () => {
    // 999999 almost certainly does not exist; taskkill returns nonzero
    // but spawnSync does not throw. Production code wraps in try/catch
    // anyway.
    expect(() => killProcessSubtree(999999)).not.toThrow();
  });

  it('does not invoke process.kill on win32 (uses taskkill instead)', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      killProcessSubtree(999999);
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
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.useRealTimers();
  });

  it('signals process group SIGTERM, then SIGKILL after 500ms', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => true) as never);
    try {
      killProcessSubtree(4321);

      // Immediate SIGTERM to negative pid (process group)
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledTimes(1);

      // Advance timers — SIGKILL should fire
      vi.advanceTimersByTime(500);
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGKILL');
      expect(killSpy).toHaveBeenCalledTimes(2);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('swallows SIGTERM throw (group already gone) and still schedules SIGKILL', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((..._args: unknown[]) => {
      throw new Error('ESRCH');
    }) as never);
    try {
      expect(() => killProcessSubtree(7)).not.toThrow();
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
