import { ulid } from 'ulid';
import pino from 'pino';
import { createRequire } from 'node:module';
import { createSupervisorDispatcher } from './dispatcher.js';
import {
  createDaemonShutdownHandler,
  DAEMON_SHUTDOWN_METHOD,
  type ShutdownActions,
  type ShutdownStep,
} from './handlers/daemon-shutdown.js';

const require = createRequire(import.meta.url);
const DAEMON_VERSION = (require('../../package.json') as { version: string }).version;

const bootNonce = ulid();

const logger = pino({
  base: {
    side: 'daemon',
    v: DAEMON_VERSION,
    pid: process.pid,
    boot: bootNonce,
  },
});

// T20 — real daemon.shutdown handler replaces the NOT_IMPLEMENTED stub. The
// per-subsystem sinks (T37 lifecycle, T40 semaphore, T41 fan-out, T28 schema)
// are still landing; for now we wire log-only sinks that observe the spec
// ordering. As each subsystem lands its driver, swap the corresponding action
// here for the real I/O — the handler stays pure.
const shutdownActions: ShutdownActions = {
  markDraining: () => {
    logger.info({ event: 'daemon-shutdown', step: 'mark-draining' }, 'state=draining');
  },
  clearHeartbeats: () => {
    logger.info({ event: 'daemon-shutdown', step: 'clear-heartbeats' }, 'heartbeats cleared');
  },
  rejectPendingCalls: () => {
    logger.info({ event: 'daemon-shutdown', droppedCalls: 0 }, 'pending calls aggregated-rejected');
  },
  drainSnapshotSemaphore: (reason) => {
    logger.info({ event: 'daemon-shutdown', step: 'drain-snapshot-semaphore', reason }, 'snapshot semaphore drained');
  },
  windDownSessions: ({ perChildDeadlineMs }) => {
    logger.info({ event: 'daemon-shutdown', step: 'wind-down-sessions', perChildDeadlineMs }, 'sessions wound down');
  },
  closeSubscribers: (reason) => {
    logger.info({ event: 'subscribers-closed', count: 0, reason }, 'fan-out subscribers closed');
  },
  finalizeLogger: () => {
    // pino.final flush — synchronous; logger.flush is best-effort under the
    // default async destination but is the documented shutdown valve.
    if (typeof logger.flush === 'function') logger.flush();
  },
  exitProcess: (code) => {
    process.exit(code);
  },
  recordStepError: (step: ShutdownStep, err: unknown) => {
    logger.error({ event: 'daemon-shutdown.step-failed', step, err: String(err) }, 'shutdown step failed');
  },
  recordDeadlineOverrun: (elapsedMs, deadlineMs) => {
    logger.warn(
      { event: 'daemon-shutdown.deadline-overrun', elapsedMs, deadlineMs },
      'shutdown drain exceeded deadline (T25 force-kill territory)',
    );
  },
};

const daemonShutdownHandler = createDaemonShutdownHandler(shutdownActions);

const supervisorDispatcher = createSupervisorDispatcher();
supervisorDispatcher.register(DAEMON_SHUTDOWN_METHOD, async (req, ctx) =>
  daemonShutdownHandler.handle(req as Parameters<typeof daemonShutdownHandler.handle>[0], {
    traceId: ctx.traceId,
    bootNonce,
  }),
);
void supervisorDispatcher;

logger.info({ event: 'daemon.boot' }, 'daemon shell booted');

// SIGTERM/SIGINT funnel through the same handler so the spec sequence runs
// regardless of whether the trigger is the supervisor RPC or a kill signal.
function shutdownFromSignal(signal: 'SIGTERM' | 'SIGINT'): void {
  logger.info({ event: `daemon.signal.${signal.toLowerCase()}` }, `${signal} received`);
  void daemonShutdownHandler.handle({ reason: signal }, { bootNonce });
}
process.on('SIGTERM', () => shutdownFromSignal('SIGTERM'));
process.on('SIGINT', () => shutdownFromSignal('SIGINT'));
