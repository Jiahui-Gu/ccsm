// T38 — SIGCHLD reaper tests.
//
// Spec: frag-3.5.1 §3.5.1.2 + §3.5.1.6 acceptance.
//
// The reaper itself is portable (pure producer with injected deps) so
// the contract tests run on every platform with FAKE deps. Only the
// real-spawn e2e is gated to non-Windows.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

import {
  installSigchldReaper,
  type SigchldReaperDeps,
  type SigchldReaperHandle,
  type WaitpidResult,
} from '../sigchld-reaper.js';

// -- Fake deps -------------------------------------------------------------

interface FakeDeps extends SigchldReaperDeps {
  /** Manually fire SIGCHLD to all subscribed handlers. */
  fireSigchld(): void;
  /** Queue an exit result for the next waitpid(pid) call. */
  setExit(pid: number, exitCode: number, signal?: string | null): void;
  /** Subscriber count (for testing uninstall detach). */
  subscriberCount(): number;
  /** Throw on next waitpid for this pid. */
  setWaitpidError(pid: number, err: unknown): void;
  /** Number of waitpid calls per pid (drain semantics). */
  waitpidCallsFor(pid: number): number;
}

function createFakeDeps(): FakeDeps {
  const subscribers = new Set<() => void>();
  // Pending exits per pid: FIFO queue. waitpid returns the head (and
  // pops) if present, else 'no-state-change'.
  const pending = new Map<number, WaitpidResult[]>();
  const errors = new Map<number, unknown>();
  const calls = new Map<number, number>();

  return {
    onSigchld(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    waitpid(pid) {
      calls.set(pid, (calls.get(pid) ?? 0) + 1);
      if (errors.has(pid)) {
        const err = errors.get(pid)!;
        errors.delete(pid);
        throw err;
      }
      const queue = pending.get(pid);
      if (!queue || queue.length === 0) {
        return { state: 'no-state-change' };
      }
      return queue.shift()!;
    },
    fireSigchld() {
      // Snapshot — handler may detach itself.
      for (const h of Array.from(subscribers)) h();
    },
    setExit(pid, exitCode, signal = null) {
      const q = pending.get(pid) ?? [];
      q.push({ state: 'exited', exitCode, signal });
      pending.set(pid, q);
    },
    subscriberCount() {
      return subscribers.size;
    },
    setWaitpidError(pid, err) {
      errors.set(pid, err);
    },
    waitpidCallsFor(pid) {
      return calls.get(pid) ?? 0;
    },
  };
}

// -- Platform guard --------------------------------------------------------

describe('sigchld-reaper: platform guard', () => {
  it.skipIf(process.platform === 'win32')(
    'installs successfully on Unix',
    () => {
      const deps = createFakeDeps();
      const handle = installSigchldReaper({
        onChildExit: () => {},
        deps,
      });
      handle.uninstall();
      expect(deps.subscriberCount()).toBe(0);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'throws on Windows (use JobObject — T39)',
    () => {
      expect(() =>
        installSigchldReaper({
          onChildExit: () => {},
          deps: createFakeDeps(),
        }),
      ).toThrow(/Unix only/);
    },
  );
});

// -- Contract tests (portable: fake deps everywhere) ----------------------

// Skip the entire contract suite on Windows because installSigchldReaper
// throws there before deps can take over. Production wiring on Win goes
// through T39's JobObject path.
describe.skipIf(process.platform === 'win32')(
  'sigchld-reaper: producer contract',
  () => {
    let handle: SigchldReaperHandle | null = null;
    afterEach(() => {
      handle?.uninstall();
      handle = null;
    });

    it('drains 5 fast children on a single SIGCHLD (coalescing)', () => {
      const deps = createFakeDeps();
      const exits: Array<{ pid: number; exitCode: number }> = [];
      handle = installSigchldReaper({
        onChildExit: (pid, st) => exits.push({ pid, exitCode: st.exitCode }),
        initialPids: [1001, 1002, 1003, 1004, 1005],
        deps,
      });

      // Simulate POSIX coalescing: 5 children exit, kernel delivers
      // ONE SIGCHLD. Reaper must drain all five in this single pass.
      for (const pid of [1001, 1002, 1003, 1004, 1005]) {
        deps.setExit(pid, 0);
      }
      deps.fireSigchld();

      expect(exits).toEqual([
        { pid: 1001, exitCode: 0 },
        { pid: 1002, exitCode: 0 },
        { pid: 1003, exitCode: 0 },
        { pid: 1004, exitCode: 0 },
        { pid: 1005, exitCode: 0 },
      ]);
      expect(handle.registered()).toEqual([]);
    });

    it('uses per-PID waitpid (not waitpid(-1)) — only registered PIDs are queried', () => {
      const deps = createFakeDeps();
      handle = installSigchldReaper({
        onChildExit: () => {},
        initialPids: [42],
        deps,
      });
      // Queue an exit for an UNREGISTERED pid; must not be reaped.
      deps.setExit(99, 0);
      deps.fireSigchld();

      // Registered pid was waitpid'd exactly once.
      expect(deps.waitpidCallsFor(42)).toBe(1);
      // Unregistered pid was never queried — proves per-PID scope.
      expect(deps.waitpidCallsFor(99)).toBe(0);
    });

    it('fires onChildExit exactly once per pid; no double-reap on second SIGCHLD', () => {
      const deps = createFakeDeps();
      const exits: number[] = [];
      handle = installSigchldReaper({
        onChildExit: (pid) => exits.push(pid),
        initialPids: [777],
        deps,
      });
      deps.setExit(777, 0);
      deps.fireSigchld();
      deps.fireSigchld(); // coalesced spurious second delivery
      deps.fireSigchld();

      expect(exits).toEqual([777]);
      // pid was removed from set after first reap, so second/third
      // SIGCHLD do not waitpid it again.
      expect(deps.waitpidCallsFor(777)).toBe(1);
    });

    it('forwards exitCode and signal verbatim', () => {
      const deps = createFakeDeps();
      const exits: Array<{ pid: number; exitCode: number; signal: string | null }> = [];
      handle = installSigchldReaper({
        onChildExit: (pid, st) =>
          exits.push({ pid, exitCode: st.exitCode, signal: st.signal }),
        initialPids: [10, 11, 12],
        deps,
      });
      deps.setExit(10, 0, null);
      deps.setExit(11, 137, 'SIGKILL');
      deps.setExit(12, 1, null);
      deps.fireSigchld();

      expect(exits).toEqual([
        { pid: 10, exitCode: 0, signal: null },
        { pid: 11, exitCode: 137, signal: 'SIGKILL' },
        { pid: 12, exitCode: 1, signal: null },
      ]);
    });

    it('drain() collects exits without a SIGCHLD (used by daemonShutdown)', () => {
      const deps = createFakeDeps();
      const exits: number[] = [];
      handle = installSigchldReaper({
        onChildExit: (pid) => exits.push(pid),
        initialPids: [200, 201],
        deps,
      });
      deps.setExit(200, 0);
      deps.setExit(201, 0);
      handle.drain();
      expect(exits).toEqual([200, 201]);
    });

    it('register / unregister / registered behave as a set', () => {
      const deps = createFakeDeps();
      handle = installSigchldReaper({ onChildExit: () => {}, deps });
      expect(handle.registered()).toEqual([]);
      handle.register(1);
      handle.register(2);
      handle.register(1); // idempotent
      expect(handle.registered().sort((a, b) => a - b)).toEqual([1, 2]);
      handle.unregister(1);
      handle.unregister(99); // idempotent
      expect(handle.registered()).toEqual([2]);
    });

    it('waitpid throw is forwarded to onWaitpidError; drain continues with remaining pids', () => {
      const deps = createFakeDeps();
      const exits: number[] = [];
      const errs: Array<{ pid: number; err: unknown }> = [];
      handle = installSigchldReaper({
        onChildExit: (pid) => exits.push(pid),
        onWaitpidError: (pid, err) => errs.push({ pid, err }),
        initialPids: [1, 2, 3],
        deps,
      });
      deps.setWaitpidError(2, new Error('ECHILD-ish'));
      deps.setExit(1, 0);
      deps.setExit(3, 0);
      deps.fireSigchld();

      expect(exits).toEqual([1, 3]);
      expect(errs).toHaveLength(1);
      expect(errs[0]!.pid).toBe(2);
      // pid 2 stays registered since the throw was not a successful
      // reap — a future SIGCHLD can retry.
      expect(handle.registered()).toEqual([2]);
    });

    it('uninstall detaches the SIGCHLD handler and clears the set', () => {
      const deps = createFakeDeps();
      const onExit = vi.fn();
      handle = installSigchldReaper({
        onChildExit: onExit,
        initialPids: [50],
        deps,
      });
      expect(deps.subscriberCount()).toBe(1);
      handle.uninstall();
      expect(deps.subscriberCount()).toBe(0);
      expect(handle.registered()).toEqual([]);
      // Post-uninstall SIGCHLDs are no-ops (handler detached).
      deps.setExit(50, 0);
      deps.fireSigchld();
      expect(onExit).not.toHaveBeenCalled();
    });

    it('default deps loader throws a clear error until T39 lands the binding', () => {
      // No deps passed — must direct caller to T39 / inject.
      expect(() =>
        installSigchldReaper({ onChildExit: () => {} }),
      ).toThrow(/no default native deps|T39/);
    });
  },
);

// -- Real-spawn smoke (Unix only) -----------------------------------------
//
// This proves the producer contract holds when wired against a tiny
// node:child_process-backed fake that mirrors real spawn/exit ordering.
// We do NOT depend on the kernel SIGCHLD signal here because Node has
// no first-class SIGCHLD listener — that is the native binding's job
// (T39). This test just demonstrates the reaper drains real PIDs when
// fed a real-ish exit signal.

describe.skipIf(process.platform === 'win32')(
  'sigchld-reaper: real spawn smoke (Unix)',
  () => {
    it('drains 5 real /bin/true children when a single drain pass fires', async () => {
      // Spawn 5 fast children. Use a portable command — `true` exists
      // on every POSIX system. Wait for all five to exit (so the
      // kernel has stamped their exit status) before draining.
      const children = await Promise.all(
        Array.from({ length: 5 }, async () => {
          const child = spawn('true');
          const exited = new Promise<void>((resolve) => {
            child.on('exit', () => resolve());
          });
          await exited;
          return child.pid!;
        }),
      );

      // Build a fake `waitpid` that says "exited code 0" exactly once
      // per known pid — emulating what the native binding will do.
      const reaped = new Set<number>();
      const deps: SigchldReaperDeps = {
        onSigchld: () => () => {},
        waitpid: (pid) =>
          reaped.has(pid)
            ? { state: 'no-state-change' }
            : (reaped.add(pid), { state: 'exited', exitCode: 0, signal: null }),
      };

      const exits: number[] = [];
      const handle = installSigchldReaper({
        onChildExit: (pid) => exits.push(pid),
        initialPids: children,
        deps,
      });
      try {
        handle.drain();
        expect(exits.sort((a, b) => a - b)).toEqual(
          [...children].sort((a, b) => a - b),
        );
        expect(handle.registered()).toEqual([]);
      } finally {
        handle.uninstall();
      }
    });
  },
);
