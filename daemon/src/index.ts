import { ulid } from 'ulid';
import pino from 'pino';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createSupervisorDispatcher } from './dispatcher.js';
import {
  createDaemonShutdownHandler,
  DAEMON_SHUTDOWN_METHOD,
  type ShutdownActions,
  type ShutdownStep,
} from './handlers/daemon-shutdown.js';
import { createForceKillSink, type ForceKillJobHandle } from './lifecycle/force-kill.js';
import { installCrashHandlers } from './crash/handlers.js';
import { installNativeCrashHandlers } from './crash/native-handlers.js';
import { initDaemonSentry } from './sentry/init.js';

const require = createRequire(import.meta.url);
const DAEMON_VERSION = (require('../../package.json') as { version: string }).version;

// Phase 4 consent gate parser. Mirrors the renderer-side `CrashConsent`
// type. Anything other than the three known strings (or undefined) is
// treated as `'pending'` — fail closed so a malformed env var never
// silently enables upload.
function parseDaemonConsent(raw: string | undefined): 'pending' | 'opted-in' | 'opted-out' {
  if (raw === 'opted-in' || raw === 'opted-out' || raw === 'pending') return raw;
  return 'pending';
}

const bootNonce = ulid();

const logger = pino({
  base: {
    side: 'daemon',
    v: DAEMON_VERSION,
    pid: process.pid,
    boot: bootNonce,
  },
});

// Phase 2 crash observability (spec §5.2 / §6, plan Task 8): initialize
// Sentry as the very first thing after logger / bootNonce are available so
// any throw in subsequent boot wiring is routed. DSN is forwarded by the
// supervisor at spawn time (electron/daemon/supervisor.ts); empty when no
// release secret is plugged in (dev / OSS forks) → init is a no-op.
initDaemonSentry({
  dsn: process.env.CCSM_DAEMON_SENTRY_DSN ?? '',
  release: DAEMON_VERSION,
  bootNonce,
  consent: parseDaemonConsent(process.env.CCSM_DAEMON_CRASH_CONSENT),
});

// Phase 1 crash observability (spec §5.2, plan Task 3):
//   * installCrashHandlers writes <runtimeRoot>/crash/<bootNonce>.json
//     marker on uncaughtException/unhandledRejection then process.exit(70).
//     The supervisor's child.on('exit') adopts the marker into the umbrella
//     incident dir alongside ring-buffer stderr/stdout tails.
const runtimeRoot = process.env.CCSM_RUNTIME_ROOT ?? path.join(os.homedir(), '.ccsm', 'runtime');

let lastTraceId: string | undefined;
export function setLastTraceId(id: string): void { lastTraceId = id; }

installCrashHandlers({
  logger,
  bootNonce,
  runtimeRoot,
  getLastTraceId: () => lastTraceId,
});

// Phase 3 crash observability (spec §5.2 option A, plan Task 11):
// POSIX-only signal trap for SIGSEGV/SIGBUS/SIGFPE/SIGILL/SIGABRT. Writes
// `<runtimeRoot>/crash/<bootNonce>-native.dmp` (a JSON marker, not a real
// minidump). Supervisor's `attachCrashCapture` adopts it as `backend.dmp`
// in the umbrella incident dir on next exit. No-op on Windows — see
// `daemon/src/crash/native-handlers.ts` for the deferred-WER rationale.
installNativeCrashHandlers({ runtimeRoot, bootNonce });

// T25 — force-kill fallback wiring. The reaper-PID set (T38) and the
// JobObject handle (T39) are owned by the per-spawn wiring that lands
// alongside the real ptyService. Until those wires are in, the
// getters return empty arrays so the sink is a safe no-op; the
// shutdown handler still calls it on overrun and the warn line
// records `targets: 0`. When the spawn wiring lands it will populate
// these snapshots from the real reaper / job-object singletons.
const childPidRegistry: Set<number> = new Set();
const jobObjectRegistry: ForceKillJobHandle[] = [];
const forceKillSink = createForceKillSink({
  getChildPids: () => Array.from(childPidRegistry),
  getJobObjects: () => jobObjectRegistry.slice(),
  recordForceKill: ({ platform, targets, errors }) => {
    logger.warn(
      { event: 'daemon-shutdown.force-kill', platform, targets, errors },
      'force-kill fallback issued after deadline overrun',
    );
  },
  onError: (target, err) => {
    logger.warn(
      { event: 'daemon-shutdown.force-kill.error', target, err: String(err) },
      'force-kill target failed',
    );
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
      'shutdown drain exceeded deadline; T25 force-kill fallback engaging',
    );
  },
  forceKillRemaining: () => {
    forceKillSink.forceKillRemaining();
  },
};

const daemonShutdownHandler = createDaemonShutdownHandler(shutdownActions);

const supervisorDispatcher = createSupervisorDispatcher();
supervisorDispatcher.register(DAEMON_SHUTDOWN_METHOD, async (req, ctx) => {
  // Phase 1 crash observability: record latest in-flight traceId so a
  // subsequent uncaught/unhandled crash can correlate the marker file
  // back to the RPC that triggered it (spec §5.2 lastTraceId).
  if (ctx.traceId) setLastTraceId(ctx.traceId);
  return daemonShutdownHandler.handle(req as Parameters<typeof daemonShutdownHandler.handle>[0], {
    traceId: ctx.traceId,
    bootNonce,
  });
});
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
