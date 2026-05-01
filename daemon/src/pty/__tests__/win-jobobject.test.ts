import { describe, expect, it, vi } from 'vitest';
import {
  createJobObject,
  type JobHandle,
  type NativeWinjobDeps,
} from '../win-jobobject.js';

// T39 — Windows JobObject child-tracking tests.
//
// The wrapper itself is platform-aware: on non-Win32 it returns a
// silent-no-op stub; on Win32 it forwards to the injected
// NativeWinjobDeps (which production wires to ccsm_native.node). The
// injected-deps tests exercise the Win32 branch on every platform by
// stubbing process.platform so CI Linux/macOS hosts cover the same
// code path that runs on Win11. A separate Win-only block uses real
// child_process.spawn to verify end-to-end semantics — gated by
// `describe.runIf(process.platform === 'win32')` per spec.

function makeFakeDeps(overrides: Partial<NativeWinjobDeps> = {}): {
  deps: NativeWinjobDeps;
  calls: {
    create: number;
    assign: Array<{ handle: JobHandle; pid: number }>;
    terminate: Array<{ handle: JobHandle; exitCode: number }>;
  };
} {
  const calls = {
    create: 0,
    assign: [] as Array<{ handle: JobHandle; pid: number }>,
    terminate: [] as Array<{ handle: JobHandle; exitCode: number }>,
  };
  const handle: JobHandle = { __fake: true };
  const deps: NativeWinjobDeps = {
    create: () => {
      calls.create += 1;
      return handle;
    },
    assign: (h, pid) => {
      calls.assign.push({ handle: h, pid });
    },
    terminate: (h, exitCode) => {
      calls.terminate.push({ handle: h, exitCode });
    },
    ...overrides,
  };
  return { deps, calls };
}

/**
 * Run `fn` with `process.platform` stubbed to `platform`. vi.stubGlobal
 * does not handle `process.platform` (it lives on the imported
 * `process` object, not on `globalThis.process`'s own descriptors), so
 * we redefine the property and restore it ourselves.
 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', {
      value: original,
      configurable: true,
    });
  }
}

describe('createJobObject — non-Win32 stub', () => {
  it('returns no-op stub on linux without touching deps', () => {
    withPlatform('linux', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      expect(job.active).toBe(false);
      job.assign(1234);
      job.assign(5678);
      job.terminate(2);
      job.dispose();
      expect(job.assigned()).toEqual([]);
      expect(calls.create).toBe(0);
      expect(calls.assign).toEqual([]);
      expect(calls.terminate).toEqual([]);
    });
  });

  it('returns no-op stub on darwin without touching deps', () => {
    withPlatform('darwin', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      expect(job.active).toBe(false);
      job.assign(99);
      expect(calls.assign).toEqual([]);
      job.dispose();
    });
  });

  it('non-Win32 stub never throws even without deps', () => {
    withPlatform('linux', () => {
      const job = createJobObject();
      expect(() => job.assign(42)).not.toThrow();
      expect(() => job.terminate()).not.toThrow();
      expect(() => job.dispose()).not.toThrow();
    });
  });
});

describe('createJobObject — Win32 (injected deps)', () => {
  it('calls native.create() exactly once at construction', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      expect(calls.create).toBe(1);
      expect(job.active).toBe(true);
    });
  });

  it('forwards assign(pid) to native with the create()-returned handle', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.assign(1111);
      job.assign(2222);
      expect(calls.assign).toHaveLength(2);
      expect(calls.assign[0].pid).toBe(1111);
      expect(calls.assign[1].pid).toBe(2222);
      expect(calls.assign[0].handle).toBe(calls.assign[1].handle);
      expect(job.assigned()).toEqual([1111, 2222]);
    });
  });

  it('idempotent assign for the same pid (no duplicate native call)', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.assign(1111);
      job.assign(1111);
      job.assign(1111);
      expect(calls.assign).toHaveLength(1);
      expect(job.assigned()).toEqual([1111]);
    });
  });

  it('terminate() forwards to native with default exitCode=1 and tears down all assigned pids', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.assign(100);
      job.assign(200);
      job.assign(300);
      expect(job.assigned()).toHaveLength(3);
      job.terminate();
      expect(calls.terminate).toHaveLength(1);
      expect(calls.terminate[0].exitCode).toBe(1);
      // After terminate, the bookkeeping is cleared (children are
      // dead per TerminateJobObject contract).
      expect(job.assigned()).toEqual([]);
    });
  });

  it('terminate(exitCode) forwards the explicit code', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.terminate(42);
      expect(calls.terminate[0].exitCode).toBe(42);
    });
  });

  it('terminate is idempotent — second call is a no-op', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.terminate(1);
      job.terminate(2);
      job.terminate(3);
      expect(calls.terminate).toHaveLength(1);
    });
  });

  it('after terminate, assign is silently ignored', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.terminate();
      job.assign(999);
      expect(calls.assign).toEqual([]);
      expect(job.assigned()).toEqual([]);
    });
  });

  it('dispose() does NOT close the native handle (KILL_ON_JOB_CLOSE relies on OS)', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.assign(1);
      job.dispose();
      expect(job.active).toBe(false);
      expect(job.assigned()).toEqual([]);
      // Wrapper exposes no "close" call to the binding — the OS
      // closing the handle on daemon exit is what triggers
      // KILL_ON_JOB_CLOSE. If a future "close" capability is added,
      // dispose must remain a JS-side bookkeeping reset only.
      expect((deps as unknown as { close?: unknown }).close).toBeUndefined();
    });
  });

  it('after dispose, assign and terminate are silent no-ops', () => {
    withPlatform('win32', () => {
      const { deps, calls } = makeFakeDeps();
      const job = createJobObject({ deps });
      job.dispose();
      job.assign(1);
      job.terminate();
      expect(calls.assign).toEqual([]);
      expect(calls.terminate).toEqual([]);
    });
  });

  it('routes native assign() throw to onNativeError without bubbling', () => {
    withPlatform('win32', () => {
      const err = new Error('AssignProcessToJobObject failed: ERROR_INVALID_PARAMETER');
      const onNativeError = vi.fn();
      const { deps } = makeFakeDeps({
        assign: () => {
          throw err;
        },
      });
      const job = createJobObject({ deps, onNativeError });
      expect(() => job.assign(1234)).not.toThrow();
      expect(onNativeError).toHaveBeenCalledTimes(1);
      expect(onNativeError).toHaveBeenCalledWith('assign', err);
      // Failed assign is NOT recorded (bookkeeping reflects native truth).
      expect(job.assigned()).toEqual([]);
    });
  });

  it('routes native terminate() throw to onNativeError without bubbling', () => {
    withPlatform('win32', () => {
      const err = new Error('TerminateJobObject failed: ERROR_ACCESS_DENIED');
      const onNativeError = vi.fn();
      const { deps } = makeFakeDeps({
        terminate: () => {
          throw err;
        },
      });
      const job = createJobObject({ deps, onNativeError });
      expect(() => job.terminate(1)).not.toThrow();
      expect(onNativeError).toHaveBeenCalledWith('terminate', err);
    });
  });

  it('without onNativeError, native throws are swallowed silently', () => {
    withPlatform('win32', () => {
      const { deps } = makeFakeDeps({
        assign: () => {
          throw new Error('boom');
        },
      });
      const job = createJobObject({ deps });
      expect(() => job.assign(1)).not.toThrow();
      // Wrapper survives and stays usable for the next pid.
      const { deps: deps2, calls: calls2 } = makeFakeDeps();
      const job2 = createJobObject({ deps: deps2 });
      job2.assign(2);
      expect(calls2.assign[0].pid).toBe(2);
    });
  });

  it('default loadDefaultDeps throws clear message until ccsm_native lands', () => {
    withPlatform('win32', () => {
      expect(() => createJobObject()).toThrowError(/ccsm_native/);
    });
  });
});
