// Task #145 — shutdown drain orchestrator tests.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md §6.6.1
//       docs/superpowers/specs/v0.3-design.md final-arch shutdown ordering.

import { describe, it, expect, vi } from 'vitest';
import {
  createShutdownDrain,
  SHUTDOWN_DRAIN_PLAN,
  SHUTDOWN_DRAIN_STEPS,
  type ShutdownDriver,
  type ShutdownDrainStep,
  type ShutdownDrainEvent,
} from '../shutdownDrain.js';

function makeDriver(overrides: Partial<ShutdownDriver> = {}): ShutdownDriver & {
  callOrder: ShutdownDrainStep[];
} {
  const callOrder: ShutdownDrainStep[] = [];
  const rec = (s: ShutdownDrainStep) => { callOrder.push(s); };
  const base: ShutdownDriver = {
    stopAcceptingNewRequests: vi.fn(() => { rec('stop-accepting'); }),
    drainInFlightEnvelope: vi.fn(() => { rec('drain-in-flight-envelope'); }),
    drainConnectStreams: vi.fn(() => { rec('drain-connect-streams'); }),
    windDownPtyChildren: vi.fn(() => { rec('wind-down-pty-children'); }),
    checkpointAndCloseDb: vi.fn(() => { rec('checkpoint-db'); }),
    closeFanoutRegistry: vi.fn(() => { rec('close-fanout-registry'); }),
    flushLogs: vi.fn(() => { rec('flush-logs'); }),
    releaseLockfile: vi.fn(() => { rec('release-lockfile'); }),
    exitProcess: vi.fn(() => { rec('exit-process'); }),
  };
  return Object.assign({ callOrder }, base, overrides);
}

describe('shutdownDrain (Task #145 — 9-step orchestrator)', () => {
  it('SHUTDOWN_DRAIN_PLAN matches SHUTDOWN_DRAIN_STEPS in order', () => {
    expect(SHUTDOWN_DRAIN_PLAN.map((s) => s.step)).toEqual([...SHUTDOWN_DRAIN_STEPS]);
  });

  it('plan has exactly 9 steps in canonical order', () => {
    expect(SHUTDOWN_DRAIN_STEPS).toEqual([
      'stop-accepting',
      'drain-in-flight-envelope',
      'drain-connect-streams',
      'wind-down-pty-children',
      'checkpoint-db',
      'close-fanout-registry',
      'flush-logs',
      'release-lockfile',
      'exit-process',
    ]);
  });

  it('plan is frozen', () => {
    expect(Object.isFrozen(SHUTDOWN_DRAIN_PLAN)).toBe(true);
  });

  it('runs every step exactly once in spec order', async () => {
    const driver = makeDriver();
    const drain = createShutdownDrain({ driver });
    const result = await drain.run();
    expect(driver.callOrder).toEqual([...SHUTDOWN_DRAIN_STEPS]);
    expect(result.ran).toEqual([...SHUTDOWN_DRAIN_STEPS]);
    expect(result.timedOut).toEqual([]);
    expect(result.errored).toEqual([]);
  });

  it('emits ordered step-start / step-finish events', async () => {
    const events: ShutdownDrainEvent[] = [];
    const drain = createShutdownDrain({
      driver: makeDriver(),
      onEvent: (e) => events.push(e),
    });
    await drain.run();
    const startSteps = events.filter((e) => e.kind === 'step-start').map((e) => (e as { step: string }).step);
    expect(startSteps).toEqual([...SHUTDOWN_DRAIN_STEPS]);
    expect(events.at(-1)?.kind).toBe('drain-complete');
  });

  it('is idempotent — second run() returns the cached result', async () => {
    const driver = makeDriver();
    const drain = createShutdownDrain({ driver });
    const r1 = await drain.run();
    const r2 = await drain.run();
    expect(r1).toBe(r2);
    // Each driver method invoked exactly once.
    expect(driver.stopAcceptingNewRequests).toHaveBeenCalledTimes(1);
    expect(driver.exitProcess).toHaveBeenCalledTimes(1);
  });

  it('concurrent run() calls share the same in-flight promise', async () => {
    const driver = makeDriver({
      stopAcceptingNewRequests: vi.fn(async () => {
        await new Promise<void>((r) => setTimeout(r, 10));
      }),
    });
    const drain = createShutdownDrain({ driver });
    const [r1, r2] = await Promise.all([drain.run(), drain.run()]);
    expect(r1).toBe(r2);
    expect(driver.stopAcceptingNewRequests).toHaveBeenCalledTimes(1);
  });

  it('continues after a step throws (partial drain over silent abort)', async () => {
    const events: ShutdownDrainEvent[] = [];
    const driver = makeDriver({
      checkpointAndCloseDb: vi.fn(() => {
        throw new Error('db handle missing');
      }),
    });
    const drain = createShutdownDrain({
      driver,
      onEvent: (e) => events.push(e),
    });
    const result = await drain.run();
    expect(result.errored).toEqual(['checkpoint-db']);
    // Subsequent steps still run.
    expect(driver.closeFanoutRegistry).toHaveBeenCalled();
    expect(driver.flushLogs).toHaveBeenCalled();
    expect(driver.releaseLockfile).toHaveBeenCalled();
    expect(driver.exitProcess).toHaveBeenCalled();
    const errEvent = events.find((e) => e.kind === 'step-error');
    expect(errEvent).toBeDefined();
  });

  it('step 2 force-progresses after the 5 s timeout (drain-in-flight-envelope)', async () => {
    vi.useFakeTimers();
    try {
      const events: ShutdownDrainEvent[] = [];
      let inFlight = 1;
      const driver = makeDriver({
        // Simulate an in-flight handler that NEVER resolves: poll loop keeps
        // waiting. The orchestrator must still progress past it via the
        // 5 s timeout.
        drainInFlightEnvelope: vi.fn(async () => {
          while (inFlight > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
        }),
      });
      const drain = createShutdownDrain({
        driver,
        onEvent: (e) => events.push(e),
      });
      const runPromise = drain.run();
      // Advance through the step-1 timeout, then through step 2's 5 s
      // timeout. We need to flush microtasks between advances so the
      // setTimeouts inside each step actually queue.
      await vi.advanceTimersByTimeAsync(200); // step 1 finishes immediately.
      await vi.advanceTimersByTimeAsync(5_500); // blow step 2's 5 s timeout.
      await vi.advanceTimersByTimeAsync(10_000); // remainder of plan.
      // Free up the in-flight counter so the never-resolving promise
      // doesn't keep the test process hanging on cleanup.
      inFlight = 0;
      await vi.advanceTimersByTimeAsync(100);
      const result = await runPromise;
      expect(result.timedOut).toContain('drain-in-flight-envelope');
      // Subsequent steps still ran.
      expect(driver.exitProcess).toHaveBeenCalled();
      // Ordering preserved despite the timeout.
      expect(driver.callOrder.indexOf('drain-in-flight-envelope')).toBeLessThan(
        driver.callOrder.indexOf('exit-process'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards reason + perChildDeadlineMs to the relevant driver methods', async () => {
    const driver = makeDriver();
    const drain = createShutdownDrain({
      driver,
      reason: 'SIGTERM',
      perChildDeadlineMs: 333,
    });
    await drain.run();
    expect(driver.drainConnectStreams).toHaveBeenCalledWith('SIGTERM');
    expect(driver.closeFanoutRegistry).toHaveBeenCalledWith('SIGTERM');
    expect(driver.windDownPtyChildren).toHaveBeenCalledWith({ perChildDeadlineMs: 333 });
  });

  it('respects per-step timeoutOverrides (test seam)', async () => {
    const driver = makeDriver({
      stopAcceptingNewRequests: vi.fn(async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
      }),
    });
    const events: ShutdownDrainEvent[] = [];
    const drain = createShutdownDrain({
      driver,
      onEvent: (e) => events.push(e),
      timeoutOverrides: { 'stop-accepting': 5 },
    });
    const result = await drain.run();
    expect(result.timedOut).toContain('stop-accepting');
  });

  it('state transitions idle -> draining -> drained', async () => {
    let resolveStep1: (() => void) | undefined;
    const driver = makeDriver({
      stopAcceptingNewRequests: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStep1 = resolve;
          }),
      ),
    });
    const drain = createShutdownDrain({
      driver,
      // Use a long step-1 override so the timeout doesn't fire while we
      // wait for the manual resolve.
      timeoutOverrides: { 'stop-accepting': 60_000 },
    });
    expect(drain.state).toBe('idle');
    const p = drain.run();
    expect(drain.state).toBe('draining');
    // Yield so the orchestrator's `Promise.resolve().then(fn)` invokes
    // the driver method and assigns resolveStep1.
    await Promise.resolve();
    await Promise.resolve();
    resolveStep1!();
    await p;
    expect(drain.state).toBe('drained');
  });
});
