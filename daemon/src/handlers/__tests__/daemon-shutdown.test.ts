import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDaemonShutdownHandler,
  DAEMON_SHUTDOWN_METHOD,
  SHUTDOWN_DEFAULT_DEADLINE_MS,
  SHUTDOWN_PLAN,
  SHUTDOWN_STEPS,
  type DaemonShutdownContext,
  type ShutdownActions,
  type ShutdownStep,
} from '../daemon-shutdown.js';
import { isSupervisorRpc } from '../../envelope/supervisor-rpcs.js';

function makeActions(overrides: Partial<ShutdownActions> = {}): ShutdownActions & {
  callOrder: ShutdownStep[];
} {
  const callOrder: ShutdownStep[] = [];
  const record = (step: ShutdownStep) => {
    callOrder.push(step);
  };
  const base: ShutdownActions = {
    markDraining: vi.fn(() => {
      record('mark-draining');
    }),
    clearHeartbeats: vi.fn(() => {
      record('clear-heartbeats');
    }),
    rejectPendingCalls: vi.fn(() => {
      record('reject-pending');
    }),
    drainSnapshotSemaphore: vi.fn((_reason: string) => {
      record('drain-snapshot-semaphore');
    }),
    windDownSessions: vi.fn((_opts) => {
      record('wind-down-sessions');
    }),
    closeSubscribers: vi.fn((_reason: string) => {
      record('close-subscribers');
    }),
    finalizeLogger: vi.fn(() => {
      record('finalize-logger');
    }),
    exitProcess: vi.fn((_code: number) => {
      record('exit-process');
    }),
    recordStepError: vi.fn(),
    recordDeadlineOverrun: vi.fn(),
    forceKillRemaining: vi.fn(),
  };
  return Object.assign({ callOrder }, base, overrides);
}

const ctx: DaemonShutdownContext = {
  traceId: '01HZZZTESTULIDXXXXXXXXX0',
  bootNonce: '01HZZZBOOTNONCEXXXXXXXX0',
};

describe('daemon.shutdown handler (T20 — frag-6-7 §6.6.1)', () => {
  describe('contract / spec wiring', () => {
    it('method literal is on SUPERVISOR_RPCS allowlist', () => {
      expect(DAEMON_SHUTDOWN_METHOD).toBe('daemon.shutdown');
      expect(isSupervisorRpc(DAEMON_SHUTDOWN_METHOD)).toBe(true);
    });

    it('SHUTDOWN_PLAN is in the canonical spec order', () => {
      expect(SHUTDOWN_PLAN.map((s) => s.step)).toEqual([
        'mark-draining',
        'clear-heartbeats',
        'reject-pending',
        'drain-snapshot-semaphore',
        'wind-down-sessions',
        'close-subscribers',
        'finalize-logger',
        'exit-process',
      ]);
    });

    it('SHUTDOWN_STEPS and SHUTDOWN_PLAN agree', () => {
      expect(SHUTDOWN_PLAN.map((s) => s.step)).toEqual([...SHUTDOWN_STEPS]);
    });

    it('SHUTDOWN_PLAN is frozen', () => {
      expect(Object.isFrozen(SHUTDOWN_PLAN)).toBe(true);
    });

    it('every plan step carries a spec ref', () => {
      for (const s of SHUTDOWN_PLAN) {
        expect(s.specRef).toMatch(/frag-(3\.5\.1|6-7)/);
        expect(s.description.length).toBeGreaterThan(10);
      }
    });
  });

  describe('ack returned promptly (before side effects)', () => {
    it('handle() resolves with ack BEFORE process.exit runs', async () => {
      // Block markDraining so the drain chain cannot complete; verify the
      // ack still resolves and exitProcess has NOT been called yet.
      let release: (() => void) | undefined;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actions = makeActions({
        markDraining: vi.fn(async () => {
          await blocker;
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      const reply = await h.handle(undefined, ctx);
      expect(reply.ack).toBe('ok');
      expect(reply.idempotency).toBe('first');
      expect(reply.bootNonce).toBe(ctx.bootNonce);
      expect(reply.planSteps).toEqual([...SHUTDOWN_STEPS]);
      // Drain chain is parked at markDraining — exit MUST NOT have fired.
      expect(actions.exitProcess).not.toHaveBeenCalled();
      expect(actions.finalizeLogger).not.toHaveBeenCalled();
      release!();
      await h.whenDrained();
      expect(actions.exitProcess).toHaveBeenCalledWith(0);
    });

    it('default deadline is 5_000 ms when caller omits', async () => {
      const h = createDaemonShutdownHandler(makeActions());
      const reply = await h.handle(undefined, ctx);
      expect(reply.deadlineMs).toBe(SHUTDOWN_DEFAULT_DEADLINE_MS);
      expect(reply.deadlineMs).toBe(5_000);
    });

    it('caller-supplied deadline is respected (after clamp)', async () => {
      const h = createDaemonShutdownHandler(makeActions());
      const reply = await h.handle({ deadlineMs: 2_000 }, ctx);
      expect(reply.deadlineMs).toBe(2_000);
    });

    it.each([
      [0, SHUTDOWN_DEFAULT_DEADLINE_MS],
      [-1, SHUTDOWN_DEFAULT_DEADLINE_MS],
      [Number.NaN, SHUTDOWN_DEFAULT_DEADLINE_MS],
      [Number.POSITIVE_INFINITY, SHUTDOWN_DEFAULT_DEADLINE_MS],
      [10, 50], // clamped UP to 50ms floor
      [10_000_000, 60_000], // clamped DOWN to 60s ceiling
    ])('clamps %j → %j', async (input, expected) => {
      const h = createDaemonShutdownHandler(makeActions());
      const reply = await h.handle({ deadlineMs: input }, ctx);
      expect(reply.deadlineMs).toBe(expected);
    });
  });

  describe('actions invoked in spec order', () => {
    it('runs all 8 steps in canonical order', async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      await h.handle(undefined, ctx);
      const ran = await h.whenDrained();
      expect(actions.callOrder).toEqual([...SHUTDOWN_STEPS]);
      expect(ran).toEqual([...SHUTDOWN_STEPS]);
    });

    it('passes the reason string to the drain sinks', async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      await h.handle({ reason: 'uninstall' }, ctx);
      await h.whenDrained();
      expect(actions.drainSnapshotSemaphore).toHaveBeenCalledWith('uninstall');
      expect(actions.closeSubscribers).toHaveBeenCalledWith('uninstall');
    });

    it("default reason is 'daemon-shutdown' (matches spec log event)", async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      await h.handle(undefined, ctx);
      await h.whenDrained();
      expect(actions.drainSnapshotSemaphore).toHaveBeenCalledWith('daemon-shutdown');
      expect(actions.closeSubscribers).toHaveBeenCalledWith('daemon-shutdown');
    });

    it('passes 200ms per-child deadline to wind-down (§6.6.1 step 4)', async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      await h.handle(undefined, ctx);
      await h.whenDrained();
      expect(actions.windDownSessions).toHaveBeenCalledWith({ perChildDeadlineMs: 200 });
    });

    it('exits with code 0', async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      await h.handle(undefined, ctx);
      await h.whenDrained();
      expect(actions.exitProcess).toHaveBeenCalledWith(0);
      expect(actions.exitProcess).toHaveBeenCalledTimes(1);
    });
  });

  describe('error tolerance (partial drain over silent abort)', () => {
    it('continues running subsequent steps when a middle step throws', async () => {
      const actions = makeActions({
        windDownSessions: vi.fn(() => {
          throw new Error('SIGCHLD reap failed');
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      await h.handle(undefined, ctx);
      await h.whenDrained();
      // exit-process MUST still be called even though wind-down threw —
      // §6.6.1 partial-drain principle.
      expect(actions.finalizeLogger).toHaveBeenCalled();
      expect(actions.exitProcess).toHaveBeenCalledWith(0);
      expect(actions.recordStepError).toHaveBeenCalledWith(
        'wind-down-sessions',
        expect.any(Error),
      );
    });

    it('async rejection is captured by recordStepError', async () => {
      const actions = makeActions({
        closeSubscribers: vi.fn(async () => {
          throw new Error('subscriber map locked');
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      await h.handle(undefined, ctx);
      await h.whenDrained();
      expect(actions.recordStepError).toHaveBeenCalledWith(
        'close-subscribers',
        expect.any(Error),
      );
      expect(actions.finalizeLogger).toHaveBeenCalled();
      expect(actions.exitProcess).toHaveBeenCalled();
    });
  });

  describe('idempotency (second daemon.shutdown is a no-op)', () => {
    it('second call returns ack with idempotency=replay and runs no actions', async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      const first = await h.handle(undefined, ctx);
      await h.whenDrained();
      const callCountAfterFirst = (actions.markDraining as ReturnType<typeof vi.fn>).mock.calls
        .length;

      const second = await h.handle(undefined, ctx);
      expect(first.idempotency).toBe('first');
      expect(second.idempotency).toBe('replay');
      expect(second.ack).toBe('ok');
      expect(second.planSteps).toEqual([...SHUTDOWN_STEPS]);

      // No additional action invocations.
      expect((actions.markDraining as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callCountAfterFirst,
      );
      expect((actions.exitProcess as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    it('replay returns the deadline from the first call', async () => {
      const h = createDaemonShutdownHandler(makeActions());
      await h.handle({ deadlineMs: 1_500 }, ctx);
      const replay = await h.handle({ deadlineMs: 9_999 }, ctx);
      expect(replay.deadlineMs).toBe(1_500);
    });

    it('concurrent re-call mid-drain returns replay (state=draining)', async () => {
      // Block the drain on a controllable promise so we can re-enter while
      // the state is still 'draining'.
      let release: (() => void) | undefined;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actions = makeActions({
        markDraining: vi.fn(async () => {
          await blocker;
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      const first = await h.handle(undefined, ctx);
      expect(h.state).toBe('draining');
      const second = await h.handle(undefined, ctx);
      expect(first.idempotency).toBe('first');
      expect(second.idempotency).toBe('replay');
      release!();
      await h.whenDrained();
      expect(h.state).toBe('drained');
    });
  });

  describe('deadline overrun reporting (T25 escalation hook)', () => {
    it('invokes recordDeadlineOverrun when wall-clock > deadlineMs at close-subscribers', async () => {
      const actions = makeActions({
        windDownSessions: vi.fn(async () => {
          await new Promise<void>((r) => setTimeout(r, 80));
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      await h.handle({ deadlineMs: 50 }, ctx);
      await h.whenDrained();
      expect(actions.recordDeadlineOverrun).toHaveBeenCalledWith(
        expect.any(Number),
        50,
      );
      const [elapsed, deadline] = (
        actions.recordDeadlineOverrun as ReturnType<typeof vi.fn>
      ).mock.calls[0]!;
      expect(elapsed).toBeGreaterThanOrEqual(deadline);
    });

    it('does NOT invoke recordDeadlineOverrun when within deadline', async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      await h.handle({ deadlineMs: 60_000 }, ctx);
      await h.whenDrained();
      expect(actions.recordDeadlineOverrun).not.toHaveBeenCalled();
    });

    it('still calls finalize-logger + exit even after deadline overrun', async () => {
      const actions = makeActions({
        windDownSessions: vi.fn(async () => {
          await new Promise<void>((r) => setTimeout(r, 80));
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      await h.handle({ deadlineMs: 50 }, ctx);
      await h.whenDrained();
      expect(actions.finalizeLogger).toHaveBeenCalled();
      expect(actions.exitProcess).toHaveBeenCalledWith(0);
    });
  });

  describe('T25 force-kill fallback wiring', () => {
    it('invokes forceKillRemaining on overrun, BEFORE finalize-logger and exit', async () => {
      const actions = makeActions({
        windDownSessions: vi.fn(async () => {
          await new Promise<void>((r) => setTimeout(r, 80));
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      await h.handle({ deadlineMs: 50 }, ctx);
      await h.whenDrained();
      expect(actions.forceKillRemaining).toHaveBeenCalledTimes(1);
      // Order check: forceKillRemaining must run before finalize-logger.
      const fkOrder = (actions.forceKillRemaining as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!;
      const flOrder = (actions.finalizeLogger as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!;
      const exOrder = (actions.exitProcess as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!;
      expect(fkOrder).toBeLessThan(flOrder);
      expect(flOrder).toBeLessThan(exOrder);
    });

    it('does NOT invoke forceKillRemaining when within deadline', async () => {
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      await h.handle({ deadlineMs: 60_000 }, ctx);
      await h.whenDrained();
      expect(actions.forceKillRemaining).not.toHaveBeenCalled();
    });

    it('forceKillRemaining throw is captured by recordStepError; finalize+exit still run', async () => {
      const actions = makeActions({
        windDownSessions: vi.fn(async () => {
          await new Promise<void>((r) => setTimeout(r, 80));
        }),
        forceKillRemaining: vi.fn(() => {
          throw new Error('native kill EPERM');
        }),
      });
      const h = createDaemonShutdownHandler(actions);
      await h.handle({ deadlineMs: 50 }, ctx);
      await h.whenDrained();
      expect(actions.recordStepError).toHaveBeenCalledWith(
        'close-subscribers',
        expect.any(Error),
      );
      expect(actions.finalizeLogger).toHaveBeenCalled();
      expect(actions.exitProcess).toHaveBeenCalledWith(0);
    });

    it('overrun without forceKillRemaining wired still records and exits cleanly', async () => {
      const actions = makeActions({
        windDownSessions: vi.fn(async () => {
          await new Promise<void>((r) => setTimeout(r, 80));
        }),
      });
      // Simulate older caller that never wired the optional hook.
      const stripped: ShutdownActions = { ...actions };
      delete (stripped as { forceKillRemaining?: unknown }).forceKillRemaining;
      const h = createDaemonShutdownHandler(stripped);
      await h.handle({ deadlineMs: 50 }, ctx);
      await h.whenDrained();
      expect(actions.recordDeadlineOverrun).toHaveBeenCalled();
      expect(actions.finalizeLogger).toHaveBeenCalled();
      expect(actions.exitProcess).toHaveBeenCalledWith(0);
    });
  });

  describe('integration with T16 dispatcher', () => {
    it('handler can be registered as the daemon.shutdown stub replacement', async () => {
      const { Dispatcher } = await import('../../dispatcher.js');
      const actions = makeActions();
      const h = createDaemonShutdownHandler(actions);
      const d = new Dispatcher();
      d.register(DAEMON_SHUTDOWN_METHOD, async (req, dctx) =>
        h.handle(req as Parameters<typeof h.handle>[0], { traceId: dctx.traceId }),
      );
      const r = await d.dispatch(
        DAEMON_SHUTDOWN_METHOD,
        { reason: 'manual' },
        { traceId: ctx.traceId },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const reply = r.value as { ack: string; idempotency: string };
      expect(reply.ack).toBe('ok');
      expect(reply.idempotency).toBe('first');
      await h.whenDrained();
      expect(actions.exitProcess).toHaveBeenCalledWith(0);
    });
  });
});
