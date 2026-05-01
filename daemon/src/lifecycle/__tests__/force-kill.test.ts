import { describe, it, expect, vi } from 'vitest';
import { createForceKillSink, type ForceKillJobHandle } from '../force-kill.js';

describe('createForceKillSink (T25 force-kill fallback)', () => {
  describe('POSIX path', () => {
    it('issues SIGKILL to every pid from getChildPids', () => {
      const kill = vi.fn();
      const sink = createForceKillSink({
        platform: 'linux',
        getChildPids: () => [101, 202, 303],
        posixKill: kill,
      });
      const n = sink.forceKillRemaining();
      expect(n).toBe(3);
      expect(kill).toHaveBeenCalledTimes(3);
      expect(kill).toHaveBeenNthCalledWith(1, 101, 'SIGKILL');
      expect(kill).toHaveBeenNthCalledWith(2, 202, 'SIGKILL');
      expect(kill).toHaveBeenNthCalledWith(3, 303, 'SIGKILL');
    });

    it('records platform=posix and target count via recordForceKill', () => {
      const recordForceKill = vi.fn();
      const sink = createForceKillSink({
        platform: 'linux',
        getChildPids: () => [10, 20],
        posixKill: vi.fn(),
        recordForceKill,
      });
      sink.forceKillRemaining();
      expect(recordForceKill).toHaveBeenCalledTimes(1);
      expect(recordForceKill).toHaveBeenCalledWith({
        platform: 'posix',
        targets: 2,
        errors: 0,
      });
    });

    it('per-pid kill throw is routed to onError, loop continues', () => {
      const onError = vi.fn();
      const recordForceKill = vi.fn();
      const kill = vi
        .fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('ESRCH');
        })
        .mockImplementationOnce(() => {});
      const sink = createForceKillSink({
        platform: 'linux',
        getChildPids: () => [1, 2, 3],
        posixKill: kill,
        onError,
        recordForceKill,
      });
      sink.forceKillRemaining();
      expect(kill).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledWith(2, expect.any(Error));
      expect(recordForceKill).toHaveBeenCalledWith({
        platform: 'posix',
        targets: 3,
        errors: 1,
      });
    });

    it('empty pid set is a silent no-op (no recordForceKill)', () => {
      const recordForceKill = vi.fn();
      const sink = createForceKillSink({
        platform: 'linux',
        getChildPids: () => [],
        posixKill: vi.fn(),
        recordForceKill,
      });
      const n = sink.forceKillRemaining();
      expect(n).toBe(0);
      expect(recordForceKill).not.toHaveBeenCalled();
    });

    it('ignores getJobObjects on POSIX', () => {
      const job: ForceKillJobHandle = { terminate: vi.fn() };
      const kill = vi.fn();
      const sink = createForceKillSink({
        platform: 'darwin',
        getChildPids: () => [42],
        getJobObjects: () => [job],
        posixKill: kill,
      });
      sink.forceKillRemaining();
      expect(kill).toHaveBeenCalledWith(42, 'SIGKILL');
      expect(job.terminate).not.toHaveBeenCalled();
    });
  });

  describe('Win32 path', () => {
    it('terminates every job handle with exit code 1', () => {
      const j1: ForceKillJobHandle = { terminate: vi.fn() };
      const j2: ForceKillJobHandle = { terminate: vi.fn() };
      const sink = createForceKillSink({
        platform: 'win32',
        getJobObjects: () => [j1, j2],
      });
      const n = sink.forceKillRemaining();
      expect(n).toBe(2);
      expect(j1.terminate).toHaveBeenCalledWith(1);
      expect(j2.terminate).toHaveBeenCalledWith(1);
    });

    it('records platform=win32 and job count via recordForceKill', () => {
      const recordForceKill = vi.fn();
      const sink = createForceKillSink({
        platform: 'win32',
        getJobObjects: () => [{ terminate: vi.fn() }],
        recordForceKill,
      });
      sink.forceKillRemaining();
      expect(recordForceKill).toHaveBeenCalledWith({
        platform: 'win32',
        targets: 1,
        errors: 0,
      });
    });

    it('per-handle terminate throw is routed to onError, loop continues', () => {
      const onError = vi.fn();
      const j1: ForceKillJobHandle = {
        terminate: vi.fn(() => {
          throw new Error('TerminateJobObject failed');
        }),
      };
      const j2: ForceKillJobHandle = { terminate: vi.fn() };
      const sink = createForceKillSink({
        platform: 'win32',
        getJobObjects: () => [j1, j2],
        onError,
      });
      sink.forceKillRemaining();
      expect(j2.terminate).toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('jobobject', expect.any(Error));
    });

    it('ignores getChildPids on Win32', () => {
      const kill = vi.fn();
      const sink = createForceKillSink({
        platform: 'win32',
        getChildPids: () => [99],
        getJobObjects: () => [],
        posixKill: kill,
      });
      sink.forceKillRemaining();
      expect(kill).not.toHaveBeenCalled();
    });

    it('empty job list is a silent no-op (no recordForceKill)', () => {
      const recordForceKill = vi.fn();
      const sink = createForceKillSink({
        platform: 'win32',
        getJobObjects: () => [],
        recordForceKill,
      });
      const n = sink.forceKillRemaining();
      expect(n).toBe(0);
      expect(recordForceKill).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('second call is a no-op (POSIX)', () => {
      const kill = vi.fn();
      const sink = createForceKillSink({
        platform: 'linux',
        getChildPids: () => [1, 2],
        posixKill: kill,
      });
      expect(sink.forceKillRemaining()).toBe(2);
      expect(sink.forceKillRemaining()).toBe(0);
      expect(sink.forceKillRemaining()).toBe(0);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(sink.invoked).toBe(true);
    });

    it('second call is a no-op (Win32)', () => {
      const job: ForceKillJobHandle = { terminate: vi.fn() };
      const sink = createForceKillSink({
        platform: 'win32',
        getJobObjects: () => [job],
      });
      sink.forceKillRemaining();
      sink.forceKillRemaining();
      expect(job.terminate).toHaveBeenCalledTimes(1);
    });

    it('snapshot getter is NOT called on the second invocation', () => {
      const getChildPids = vi.fn(() => [1]);
      const sink = createForceKillSink({
        platform: 'linux',
        getChildPids,
        posixKill: vi.fn(),
      });
      sink.forceKillRemaining();
      sink.forceKillRemaining();
      expect(getChildPids).toHaveBeenCalledTimes(1);
    });
  });

  describe('safe defaults', () => {
    it('with no getters supplied, returns 0 and does nothing', () => {
      const sink = createForceKillSink({ platform: 'linux', posixKill: vi.fn() });
      expect(sink.forceKillRemaining()).toBe(0);
      expect(sink.invoked).toBe(true);
    });

    it('invoked starts false, flips true after first call', () => {
      const sink = createForceKillSink({ platform: 'linux', posixKill: vi.fn() });
      expect(sink.invoked).toBe(false);
      sink.forceKillRemaining();
      expect(sink.invoked).toBe(true);
    });

    it('platform defaults to process.platform when not overridden', () => {
      // Smoke: just verify it constructs and invocation does not throw.
      const sink = createForceKillSink({
        getChildPids: () => [],
        getJobObjects: () => [],
        posixKill: vi.fn(),
      });
      expect(() => sink.forceKillRemaining()).not.toThrow();
    });
  });
});
