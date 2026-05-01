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
import { startDevParentWatchdog } from './lifecycle/dev-parent-watchdog.js';
import { installCrashHandlers } from './crash/handlers.js';
import { installNativeCrashHandlers } from './crash/native-handlers.js';
import { initDaemonSentry } from './sentry/init.js';
import { resolveRuntimeRoot } from './sockets/runtime-root.js';
import {
  createControlSocketServer,
  type ControlSocketServer,
} from './sockets/control-socket.js';
import {
  createDataSocketServer,
  type DataSocketServer,
} from './sockets/data-socket.js';

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
//
// Forward-declared so the shutdown actions can close them on the way out;
// assigned just below where listen() is called. Kept as `let | undefined`
// so a bind failure (e.g. a stale lockfile-less crash + manual sock leftover)
// still lets the shutdown sequence run.
let controlSocket: ControlSocketServer | undefined;
let dataSocket: DataSocketServer | undefined;

async function closeTransports(): Promise<void> {
  // Close both transports in parallel — they are independent listeners
  // (separate inodes / pipe names). Best-effort: log any error so the
  // supervisor's incident-dir captures it but never throw out of the
  // shutdown path.
  await Promise.allSettled([
    (async () => {
      if (!controlSocket) return;
      try {
        await controlSocket.close();
      } catch (err) {
        logger.warn(
          { event: 'daemon-shutdown.control-socket-close-failed', err: String(err) },
          'control-socket close failed during shutdown',
        );
      }
    })(),
    (async () => {
      if (!dataSocket) return;
      try {
        await dataSocket.close();
      } catch (err) {
        logger.warn(
          { event: 'daemon-shutdown.data-socket-close-failed', err: String(err) },
          'data-socket close failed during shutdown',
        );
      }
    })(),
  ]);
}

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
    // Close OS-level socket listeners before exiting so the next boot does
    // not collide on a stale POSIX socket node / leftover Windows pipe
    // handle. Best-effort + bounded — `closeTransports` swallows + logs all
    // errors and `Promise.allSettled` cannot reject.
    void closeTransports().finally(() => process.exit(code));
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

// Task #1072 — wire OS-level socket listeners.
//
// Before this PR, both `createControlSocketServer` (T14 #676) and
// `createDataSocketServer` (T15 #673) factories existed but no production
// boot path ever called `.listen()`. The control plane was dead code in
// production: every probe (PR #737 T73 daemon-boot+hello, PR #738 T74
// upgrade-in-place) had to degrade to in-process handler invocation and
// document "real socket round-trip out of scope until controlSocket.listen()
// is wired" in its PR body.
//
// Scope of this wire-up (deliberately minimal, atomic):
//   1. Resolve the canonical socket runtimeRoot via the T13 resolver
//      (`<dataRoot>/run` on Windows / macOS, `XDG_RUNTIME_DIR/ccsm` on Linux).
//      This is INTENTIONALLY a separate path from the crash-handler
//      `runtimeRoot` above (which uses `~/.ccsm/runtime` for legacy reasons);
//      a follow-up can unify, but that is OUT OF SCOPE here — we are only
//      wiring listeners, not reorganising the on-disk layout.
//   2. Bind the control socket FIRST so a `/healthz` probe sees a listener
//      the moment "daemon shell booted" hits stdout. The data socket binds
//      next; per spec the two are independent listeners and either one
//      becoming available unblocks a different class of consumer.
//   3. The connection-handler is a logged-destroy placeholder: the envelope
//      adapter that would route Duplex bytes → `decodeFrame` → dispatcher is
//      a separate piece of work (T-future / next slice). Today the listener
//      being BOUND is enough to (a) flip the double-bind guard outcome from
//      "absent" to "alive", and (b) let probes do `net.connect` to verify
//      the OS endpoint exists. Routing real RPCs over the wire lands when
//      the envelope adapter does.
//
// What this resolves (per task brief):
//   - PR #737 (T73, task #1030) "real socket round-trip out of scope" note —
//     swap their in-process handler call for `net.connect` once this lands.
//   - PR #738 (T74, task #1031) same in-process degradation note.
//
// What this does NOT do (deliberately, per task Don'ts):
//   - Does not change socket path resolution (T13 surface is untouched).
//   - Does not change the /healthz handler (T17 territory).
//   - Does not register new RPCs.
//   - Does not touch v0.4 `connect/` Connect-RPC scaffold.
const socketRuntimeRoot = resolveRuntimeRoot();

// Test isolation hooks. Allow overriding the bound socket path via env so
// integration tests can inject a unique address per run (Windows named-pipe
// names are user-scoped and otherwise collide across consecutive boots
// in fast test loops). Production leaves both unset and the factories
// derive the canonical paths.
const controlSocketPathOverride = process.env.CCSM_CONTROL_SOCKET_PATH;
const dataSocketPathOverride = process.env.CCSM_DATA_SOCKET_PATH;

controlSocket = createControlSocketServer({
  runtimeRoot: socketRuntimeRoot,
  ...(controlSocketPathOverride ? { socketPath: controlSocketPathOverride } : {}),
  logger: {
    warn: (obj, msg) => logger.warn(obj, msg),
    info: (obj, msg) => logger.info(obj, msg),
  },
  onConnection: (sock) => {
    // Envelope adapter wiring is T-future. Until then, every accepted
    // connection is destroyed loudly so a probe sees "connect succeeded
    // then peer hung up" rather than a wedge. The transport-level rate
    // cap (50/s) still fires on a flood; this destroy is per-connection
    // application-layer cleanup.
    logger.warn(
      { event: 'control-socket.connection.no-adapter', address: controlSocket?.address },
      'control-socket connection accepted but no envelope adapter is wired yet (T-future); destroying',
    );
    try {
      sock.destroy();
    } catch {
      // best-effort
    }
  },
});

dataSocket = createDataSocketServer({
  runtimeRoot: socketRuntimeRoot,
  ...(dataSocketPathOverride ? { socketPath: dataSocketPathOverride } : {}),
  logger: {
    warn: (obj, msg) => logger.warn(obj, msg),
  },
  onConnection: ({ socket }) => {
    logger.warn(
      { event: 'data-socket.connection.no-adapter', address: dataSocket?.address() },
      'data-socket connection accepted but no envelope adapter is wired yet (T-future); destroying',
    );
    try {
      socket.destroy();
    } catch {
      // best-effort
    }
  },
});

try {
  await controlSocket.listen();
  logger.info(
    { event: 'daemon.boot.control-socket-listening', address: controlSocket.address },
    'control-socket bound',
  );
} catch (err) {
  logger.error(
    { event: 'daemon.boot.control-socket-bind-failed', err: String(err) },
    'control-socket bind failed — supervisor /healthz probe will see EAGAIN/ENOENT',
  );
  // Do NOT swallow: a bind failure on the supervisor transport means the
  // daemon is not reachable for shutdown / health probes. Re-throw so the
  // crash handler routes it as an uncaught and the supervisor restarts us
  // with a clean slate.
  throw err;
}

try {
  await dataSocket.listen();
  logger.info(
    { event: 'daemon.boot.data-socket-listening', address: dataSocket.address() },
    'data-socket bound',
  );
} catch (err) {
  logger.error(
    { event: 'daemon.boot.data-socket-bind-failed', err: String(err) },
    'data-socket bind failed — renderer RPCs will not connect',
  );
  // Same posture as the control-socket: refuse to boot in a half-bound
  // state. The supervisor's restart loop is the right recovery surface.
  throw err;
}

logger.info({ event: 'daemon.boot' }, 'daemon shell booted');

// SIGTERM/SIGINT funnel through the same handler so the spec sequence runs
// regardless of whether the trigger is the supervisor RPC or a kill signal.
function shutdownFromSignal(signal: 'SIGTERM' | 'SIGINT'): void {
  logger.info({ event: `daemon.signal.${signal.toLowerCase()}` }, `${signal} received`);
  void daemonShutdownHandler.handle({ reason: signal }, { bootNonce });
}
process.on('SIGTERM', () => shutdownFromSignal('SIGTERM'));
process.on('SIGINT', () => shutdownFromSignal('SIGINT'));

// B9 (Task #25) — dev-mode parent-PID watchdog.
//
// In `CCSM_DAEMON_DEV=1` (npm run dev), nodemon owns the daemon
// lifecycle but its SIGTERM does not always propagate through the tsx
// wrapper to this Node process — especially on Windows, where Node has
// no real SIGTERM. Without this watchdog the daemon survives nodemon's
// kill, the next file save spawns a fresh daemon, and `tasklist` /
// `ps` shows N stray PIDs after a few reloads.
//
// Production stays untouched: the supervisor (electron/daemon/
// supervisor.ts) intentionally keeps the daemon alive past Electron
// exit (v0.3 dogfood criterion #1). This block is gated on
// `CCSM_DAEMON_DEV` so it can never engage in a packaged build.
if (process.env.CCSM_DAEMON_DEV === '1') {
  const ppid = process.ppid;
  if (ppid && ppid > 0) {
    startDevParentWatchdog({
      ppid,
      onParentGone: () => {
        logger.info(
          { event: 'daemon.dev.parent-gone', ppid },
          'dev parent (nodemon/tsx) exited, self-terminating to prevent stray leak',
        );
        // Fire the same shutdown path so transports release their bind
        // slots before exit. exitProcess(0) closes sockets then calls
        // process.exit(0).
        void daemonShutdownHandler.handle({ reason: 'SIGTERM' }, { bootNonce });
      },
      onUnknown: (probedPpid) => {
        logger.warn(
          { event: 'daemon.dev.parent-probe-unknown', ppid: probedPpid },
          'dev parent probe returned non-ESRCH error; assuming alive',
        );
      },
    });
    logger.info(
      { event: 'daemon.dev.parent-watchdog-armed', ppid },
      'dev parent watchdog armed (B9)',
    );
  }
}
