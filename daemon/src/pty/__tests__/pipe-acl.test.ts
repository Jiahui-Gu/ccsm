// T45 — Windows named-pipe ACL hardening tests.
//
// Spec: frag-3.5.1 §3.5.1.6 + §3.5.1.1.a (NativeBinding swap
// interface) + v0.3-design §3.1.1 + frag-6-7 §7.M1.
//
// The wrapper is portable (pure sink with injected deps) so the
// contract tests run on every platform with FAKE deps. The Win32
// platform branch is asserted on Win32; the non-Win32 silent no-op
// is asserted everywhere else.

import { describe, expect, it, vi } from 'vitest';

import {
  applyPipeAcl,
  type NativePipeAclDeps,
} from '../pipe-acl.js';

// -- Fake deps -------------------------------------------------------------

interface FakeDeps extends NativePipeAclDeps {
  /** All paths passed to applyOwnerOnly, in call order. */
  calls: string[];
  /** Make the next applyOwnerOnly call throw. */
  setError(err: unknown): void;
}

function createFakeDeps(): FakeDeps {
  const calls: string[] = [];
  let pendingError: unknown | undefined;
  return {
    calls,
    applyOwnerOnly(pipePath: string): void {
      if (pendingError !== undefined) {
        const err = pendingError;
        pendingError = undefined;
        throw err;
      }
      calls.push(pipePath);
    },
    setError(err: unknown): void {
      pendingError = err;
    },
  };
}

// -- Cross-platform contract: non-Win32 silent no-op ----------------------

describe.skipIf(process.platform === 'win32')(
  'pipe-acl: non-Win32 silent no-op',
  () => {
    it('returns silently without invoking deps on non-Win32', () => {
      const deps = createFakeDeps();
      // Even with deps that would record a call, non-Win32 path
      // returns BEFORE touching deps — the unix-socket chmod 0600
      // owned by socket/listener.ts is the POSIX-side guarantee.
      expect(() =>
        applyPipeAcl('\\\\.\\pipe\\ccsm-daemon-test', { deps }),
      ).not.toThrow();
      expect(deps.calls).toEqual([]);
    });

    it('returns silently even without deps (no default loader invoked)', () => {
      // The default loader throws "frag-11 / ccsm_native" — proving
      // we did not invoke it requires showing applyPipeAcl does NOT
      // throw with no deps on non-Win32.
      expect(() => applyPipeAcl('\\\\.\\pipe\\ccsm-daemon-test')).not.toThrow();
    });
  },
);

// -- Win32 platform branch ------------------------------------------------

describe.skipIf(process.platform !== 'win32')(
  'pipe-acl: Win32 sink contract',
  () => {
    it('forwards the pipe path to deps.applyOwnerOnly verbatim', () => {
      const deps = createFakeDeps();
      const pipePath = '\\\\.\\pipe\\ccsm-daemon-S-1-5-21-1234';
      applyPipeAcl(pipePath, { deps });
      expect(deps.calls).toEqual([pipePath]);
    });

    it('invokes the binding exactly once per call (no retries, no double-fire)', () => {
      const deps = createFakeDeps();
      const spy = vi.spyOn(deps, 'applyOwnerOnly');
      applyPipeAcl('\\\\.\\pipe\\ccsm-daemon-a', { deps });
      applyPipeAcl('\\\\.\\pipe\\ccsm-daemon-b', { deps });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\ccsm-daemon-a');
      expect(spy).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\ccsm-daemon-b');
    });

    it('propagates native errors to caller (fail-loud — boot must abort)', () => {
      const deps = createFakeDeps();
      const err = new Error('ERROR_ACCESS_DENIED');
      deps.setError(err);
      // Decider (listener) decides whether a failure is fatal; the
      // wrapper does not swallow. Per frag-6-7 §7.M1 spec, a pipe
      // with the default Everyone-DACL is a security failure that
      // must fail boot, not log-and-continue — hence no try/catch
      // in the wrapper.
      expect(() =>
        applyPipeAcl('\\\\.\\pipe\\ccsm-daemon-fail', { deps }),
      ).toThrow(err);
    });

    it('default deps loader throws a clear error pointing at frag-11 / ccsm_native', () => {
      // No deps passed — must direct caller to frag-11 / inject.
      // Mirrors T38/T39 loadDefaultDeps() contract.
      expect(() => applyPipeAcl('\\\\.\\pipe\\ccsm-daemon-x')).toThrow(
        /no default native deps|frag-11|ccsm_native/,
      );
    });
  },
);

// -- Default-loader contract (portable via process.platform stub) ---------
//
// The default loader must throw a clear "wire ccsm_native (frag-11)"
// pointer regardless of host OS. On non-Win32 the platform branch
// short-circuits before the loader is consulted; we stub
// `process.platform = 'win32'` to exercise the loader-call path on
// any CI host. Mirrors T38's "default deps loader" test.

describe('pipe-acl: default loader pointer (portable)', () => {
  it('default loader throws referencing frag-11 / ccsm_native when no deps injected', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      expect(() => applyPipeAcl('\\\\.\\pipe\\ccsm-daemon-loader-test')).toThrow(
        /no default native deps|frag-11|ccsm_native/,
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });
});
