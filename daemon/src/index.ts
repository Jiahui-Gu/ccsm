import { ulid } from 'ulid';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createDaemonLogger } from './log/index.js';
import { resolveDataRoot } from './db/ensure-data-dir.js';
import { createSupervisorDispatcher, createDataDispatcher } from './dispatcher.js';
import { mountEnvelopeAdapter } from './envelope/adapter.js';
import {
  createDaemonShutdownHandler,
  DAEMON_SHUTDOWN_METHOD,
  type ShutdownActions,
  type ShutdownStep,
} from './handlers/daemon-shutdown.js';
import { createForceKillSink, type ForceKillJobHandle } from './lifecycle/force-kill.js';
import { startDevParentWatchdog } from './lifecycle/dev-parent-watchdog.js';
import {
  acquireDaemonLock,
  LockfileBusyError,
  LockfileFatalError,
  LOCKFILE_FATAL_EXIT_CODE,
  type LockHandle,
} from './lifecycle/lockfile.js';
import { resolveDataRoot } from './db/ensure-data-dir.js';
import {
  createShutdownDrain,
  type ShutdownDriver,
} from './lifecycle/shutdownDrain.js';
import {
  startDiskCapWatchdog,
  DEFAULT_LOGS_CAP_BYTES,
  DEFAULT_CRASHES_CAP_BYTES,
  DEFAULT_DISK_CAP_TICK_MS,
} from './lifecycle/diskCapWatchdog.js';
import * as fs from 'node:fs';
import { native, IsBindingMissingError } from './native/index.js';
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
import {
  wireSupervisorDispatcher,
  defaultWriteShutdownMarker,
} from './supervisor-wiring.js';

const require = createRequire(import.meta.url);
// Resolve the daemon's own package.json (frag-11 §11.1: daemon is a
// standalone pkg-bundled binary; version lives in daemon/package.json,
// not the root workspace package.json which pkg cannot reach across the
// package boundary).
const DAEMON_VERSION = (require('../package.json') as { version: string }).version;

// Phase 4 consent gate parser. Mirrors the renderer-side `CrashConsent`
// type. Anything other than the three known strings (or undefined) is
// treated as `'pending'` — fail closed so a malformed env var never
// silently enables upload.
function parseDaemonConsent(raw: string | undefined): 'pending' | 'opted-in' | 'opted-out' {
  if (raw === 'opted-in' || raw === 'opted-out' || raw === 'pending') return raw;
  return 'pending';
}

const bootNonce = ulid();
// Captured ONCE at boot so /healthz `uptimeMs` is monotonic across calls
// (frag-6-7 §6.5). MUST be before any handler module that consumes it.
const bootedAtMs = Date.now();

const logger = createDaemonLogger({
  // Frag-12 §12.1 — log dir is `<dataRoot>/logs/daemon/`. Resolve the
  // OS-native dataRoot via the same per-OS resolver the SQLite migration
  // uses (T34) so the logger and the database share one parent root.
  dataRoot: resolveDataRoot(),
  version: DAEMON_VERSION,
  pid: process.pid,
  bootNonce,
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

// Task #123 — daemon single-instance lockfile (frag-6-7 §6.4).
//
// Acquired BEFORE any data-dir or socket work so:
//   1. A second daemon spawned by a racing supervisor exits cleanly via
//      `LockfileBusyError` instead of half-binding sockets and
//      half-touching the data dir (frag-8 §8.3 step 1a's orphan-tmp
//      unlink is only safe under single-instance enforcement).
//   2. EROFS / read-only mount surfaces as a clear `lockfile_erofs_fatal`
//      log + exit(78) BEFORE pino's async destination buffers anything
//      we cannot flush.
//
// Forward-declared so:
//   - The `daemon.shutdownForUpgrade` handler's `releaseLock` action
//     (frag-6-7 §6.4 step 4) can release the same handle the boot path
//     acquired (swap-lock contract).
//   - The `closeTransports`-then-exit shutdown chain can release on
//     planned exit so the next boot doesn't see a stale `.lock` dir.
//
// The acquire itself runs inside the same async IIFE that boots the
// listeners (below) — first step. A throw there propagates through the
// crash handler so a fatal lockfile error gets the same forensic
// treatment as any other boot failure.
const dataRoot =
  process.env.CCSM_DATA_ROOT ?? resolveDataRoot();
let lockHandle: LockHandle | undefined;

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
    // Release the daemon-singleton lockfile so the next boot does not
    // see a stale `daemon.lock.lock` directory and have to walk the
    // stale-PID steal path. `release()` is idempotent — the upgrade
    // handler may have already invoked it via the swap-lock contract.
    (async () => {
      if (!lockHandle) return;
      try {
        await lockHandle.release();
      } catch (err) {
        logger.warn(
          { event: 'daemon-shutdown.lockfile-release-failed', err: String(err) },
          'daemon.lock release failed during shutdown',
        );
      }
    })(),
  ]);
}

// Task #145 — aggregate disk-cap watchdog. Started AFTER the runtime
// dirs exist (logs / crash) below; declared here so shutdownDriver.step
// 9 can stop it before process.exit.
let diskCapWatchdog: ReturnType<typeof startDiskCapWatchdog> | undefined;

// Task #145 — module-level draining flag flipped by step 1 of the
// 9-step shutdown drain. The dispatcher / Connect server check this on
// inbound dispatch and short-circuit with UNAVAILABLE so new requests
// can never block the drain. In-flight calls are not affected — step 2
// awaits them.
let daemonDraining = false;
export function isDaemonDraining(): boolean {
  return daemonDraining;
}

// In-flight envelope handler tracker. The envelope adapter increments
// this at handler-start and decrements at handler-finish (wired in a
// follow-up slice; today this counter is 0 and step 2 returns
// immediately). The accessor is exported so the adapter can plug in
// without circular-importing shutdownDrain.
let inFlightHandlers = 0;
export function trackHandlerStart(): void { inFlightHandlers += 1; }
export function trackHandlerFinish(): void {
  inFlightHandlers = Math.max(0, inFlightHandlers - 1);
}

// Task #145 — 9-step shutdown drain driver. Each field is a real
// subsystem call where the subsystem already exposes one; placeholder-
// shaped (no-op + log) where the owning slice has not landed yet.
// Driver swap-friendly: when #108 (PTY FSM) / #105 (DB handle) /
// #123 (lockfile) land, only the field bodies here change.
const shutdownDriver: ShutdownDriver = {
  // Step 1 — flip the draining flag. New dispatch calls short-circuit.
  stopAcceptingNewRequests: () => {
    daemonDraining = true;
    logger.info({ event: 'daemon-shutdown', step: 'stop-accepting' }, 'state=draining');
  },
  // Step 2 — wait for in-flight envelope handlers to settle. Polled
  // because the handler set is owned by N independent dispatcher slots;
  // a single Promise.all would require centralising the registration
  // (out of scope for #145). Bounded by the orchestrator's 5 s timeout.
  drainInFlightEnvelope: async () => {
    const pollMs = 25;
    while (inFlightHandlers > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
  },
  // Step 3 — emit going_away on Connect/fan-out subscribers. The fan-out
  // registry singleton lands with #108; today this logs the intent so
  // the wire ordering test can observe step 3.
  drainConnectStreams: (reason) => {
    logger.info({ event: 'daemon-shutdown', step: 'drain-connect-streams', reason }, 'connect/fanout going_away');
  },
  // Step 4 — wait for PTY children to exit via ccsm_native.sigchld.
  // Today the per-spawn registry (childPidRegistry) is empty until the
  // PTY spawn wiring lands; loop is a no-op then. When children exist
  // we waitpid(-1) once per known PID with a per-child deadline.
  windDownPtyChildren: async ({ perChildDeadlineMs }) => {
    const pids = Array.from(childPidRegistry);
    if (pids.length === 0 || process.platform === 'win32') return;
    let binding: ReturnType<typeof native> | null = null;
    try {
      binding = native();
    } catch (err) {
      if (IsBindingMissingError(err)) {
        logger.warn(
          { event: 'daemon-shutdown.sigchld-missing', err: String(err) },
          'ccsm_native.sigchld unavailable; skipping PTY wind-down',
        );
        return;
      }
      throw err;
    }
    for (const pid of pids) {
      const start = Date.now();
      try {
        // waitpid is non-blocking; poll until the child reports exited or
        // we exceed the per-child deadline.
        while (Date.now() - start < perChildDeadlineMs) {
          const r = binding.sigchld.waitpid(pid);
          if (r && r.state === 'exited') break;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      } catch (err) {
        logger.warn(
          { event: 'daemon-shutdown.sigchld-waitpid-failed', pid, err: String(err) },
          'waitpid failed during PTY wind-down',
        );
      }
    }
  },
  // Step 5 — SQLite WAL checkpoint + close. Placeholder-shaped:
  // #105 hasn't exposed a daemon-wide DB handle yet (each handler
  // opens its own better-sqlite3 instance). When the shared handle
  // lands, swap this for `db.pragma('wal_checkpoint(TRUNCATE)'); db.close();`.
  checkpointAndCloseDb: () => {
    logger.info(
      { event: 'daemon-shutdown', step: 'checkpoint-db', placeholder: true },
      'DB checkpoint deferred to #105 shared-handle slice',
    );
  },
  // Step 6 — final fan-out registry sweep. Placeholder until #108 lands
  // the registry singleton in this process.
  closeFanoutRegistry: (reason) => {
    logger.info(
      { event: 'subscribers-closed', count: 0, reason, placeholder: true },
      'fan-out registry close deferred to #108',
    );
  },
  // Step 7 — best-effort logger flush. #147 will swap for pino.final.
  flushLogs: () => {
    if (typeof logger.flush === 'function') logger.flush();
  },
  // Step 8 — release the daemon lockfile. #123 will replace this with
  // proper-lockfile.unlock; today we fall back to fs.unlink of the
  // canonical path and swallow ENOENT (no lock acquired this boot).
  releaseLockfile: async () => {
    const lockPath = process.env.CCSM_DAEMON_LOCKFILE_PATH
      ?? path.join(runtimeRoot, 'daemon.lock');
    try {
      await fs.promises.unlink(lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          { event: 'daemon-shutdown.lockfile-release-failed', lockPath, err: String(err) },
          'lockfile unlink failed; supervisor restart loop is recovery surface',
        );
      }
    }
  },
  // Step 9 — close transports then process.exit. Stop the disk-cap
  // watchdog so its tick cannot fire mid-exit.
  exitProcess: async (code) => {
    diskCapWatchdog?.stop();
    await closeTransports();
    process.exit(code);
  },
};

const shutdownDrainOrchestrator = createShutdownDrain({
  driver: shutdownDriver,
  onEvent: (e) => {
    switch (e.kind) {
      case 'step-start':
        logger.info({ event: 'daemon-shutdown.step-start', step: e.step }, 'shutdown step start');
        break;
      case 'step-finish':
        logger.info(
          { event: 'daemon-shutdown.step-finish', step: e.step, elapsedMs: Math.round(e.elapsedMs) },
          'shutdown step finish',
        );
        break;
      case 'step-timeout':
        logger.warn(
          { event: 'daemon-shutdown.step-timeout', step: e.step, timeoutMs: e.timeoutMs },
          'shutdown step exceeded timeout; forcing progress',
        );
        break;
      case 'step-error':
        logger.error(
          { event: 'daemon-shutdown.step-error', step: e.step, err: String(e.err) },
          'shutdown step threw',
        );
        break;
      case 'drain-complete':
        logger.info(
          { event: 'daemon-shutdown.drain-complete', steps: [...e.ran], elapsedMs: Math.round(e.elapsedMs) },
          'shutdown drain complete',
        );
        break;
    }
  },
});

// The wire-facing daemon.shutdown handler keeps its 7-step contract
// (callers still see SHUTDOWN_PLAN steps in the ack) but every action
// delegates to the 9-step drain orchestrator. The handler invokes
// markDraining first; we fire `shutdownDrainOrchestrator.run()` there
// and let it own the rest. Subsequent action methods are no-ops because
// the orchestrator is idempotent — calling run() twice returns the
// cached result.
const shutdownActions: ShutdownActions = {
  markDraining: () => {
    void shutdownDrainOrchestrator.run();
  },
  clearHeartbeats: () => {
    // Folded into the drain orchestrator (no-op here for spec-ack shape).
  },
  rejectPendingCalls: () => {
    // Folded into step 2 of the drain orchestrator.
  },
  drainSnapshotSemaphore: () => {
    // Folded into step 4 of the drain orchestrator (PTY children wind-down).
  },
  windDownSessions: () => {
    // Folded into step 4 of the drain orchestrator.
  },
  closeSubscribers: () => {
    // Folded into steps 3 + 6 of the drain orchestrator.
  },
  finalizeLogger: () => {
    // Folded into step 7 of the drain orchestrator.
  },
  exitProcess: () => {
    // Folded into step 9 of the drain orchestrator. Run is idempotent
    // so this is a no-op when the orchestrator already fired in
    // markDraining; if for some reason markDraining didn't run (test
    // double, partial mount), kick the orchestrator now.
    void shutdownDrainOrchestrator.run();
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

// Task #28 / B7a — daemon-side envelope adapter.
//
// Per-plane dispatchers consumed by the envelope adapter mounted on each
// accepted connection (control-socket -> supervisor plane, data-socket ->
// data plane). The data dispatcher is bare today; per-method handlers are
// wired by their owning task slices. The adapter forwards UNKNOWN_METHOD
// cleanly for any method not yet registered, so this slice is safe to ship
// before the handlers do.
const dataDispatcher = createDataDispatcher();
void dataDispatcher;

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

// Task #100 — wire the remaining SUPERVISOR_RPCS handlers (audit-4 F8).
//
// Before this slice, the daemon shell only registered `daemon.shutdown` on
// `supervisorDispatcher`; calls to `/healthz`, `/stats`, and
// `daemon.shutdownForUpgrade` short-circuited to the NOT_IMPLEMENTED stubs
// even though pure handlers existed (T17 / T18 / T21).
//
// `daemon.hello` is intentionally NOT wired here — the HMAC handshake is
// being decoupled in a separate slice and the secret-loading site is still
// in flux. Until that lands, `daemon.hello` keeps returning NOT_IMPLEMENTED
// (the dispatcher's stub) so the supervisor plane stays free of HMAC
// coupling per the Task #100 constraint.
const supervisorWiringManifest = wireSupervisorDispatcher(supervisorDispatcher, {
  healthz: {
    bootNonce,
    pid: process.pid,
    version: DAEMON_VERSION,
    bootedAtMs,
    now: () => Date.now(),
    // Live counter providers will be plugged in by their owning subsystems
    // (session registry, fan-out registry, migration FSM, swap-window
    // observer) as they land. Defaults to 0 / 'absent' / false until then —
    // the wire field is always present so renderer parsing never breaks.
  },
  stats: {
    // getMemoryUsage falls back to process.memoryUsage(); see
    // defaultMemoryUsageProvider in handlers/stats.ts.
  },
  shutdownForUpgrade: {
    ctx: {
      version: DAEMON_VERSION,
      now: () => Date.now(),
      markerDir: socketRuntimeRoot,
    },
    actions: {
      writeMarker: defaultWriteShutdownMarker,
      // The upgrade path's drain is the same §6.6.1 sequence the manual
      // shutdown handler runs. Reuse the already-wired handler so both
      // RPCs converge on one code path.
      runShutdownSequence: async () => {
        await daemonShutdownHandler.handle({ reason: 'upgrade' }, { bootNonce });
      },
      // frag-6-7 §6.4 step 4 (swap-lock contract): release the SAME
      // `daemon.lock` the boot path acquired so the supervisor's binary
      // swap window cannot race a fresh-daemon-boot for the bin/
      // directory. If the handle is undefined (acquire deferred /
      // skipped — e.g. test override env), fall back to a no-op log
      // line so the marker write + drain still complete.
      releaseLock: async () => {
        if (!lockHandle) {
          logger.info(
            { event: 'daemon-shutdown-for-upgrade.release-lock-noop' },
            'lockfile not held; continuing exit',
          );
          return;
        }
        try {
          await lockHandle.release();
          logger.info(
            { event: 'daemon-shutdown-for-upgrade.release-lock' },
            'daemon.lock released for upgrade swap window',
          );
        } catch (err) {
          logger.warn(
            { event: 'daemon-shutdown-for-upgrade.release-lock-failed', err: String(err) },
            'daemon.lock release failed; supervisor will retry-or-steal on next boot',
          );
        }
      },
      exit: (code) => {
        // Same posture as `shutdownActions.exitProcess`: close transports
        // before exit so the next boot does not collide on stale socket
        // nodes. Best-effort + bounded.
        void closeTransports().finally(() => process.exit(code));
      },
    },
    onError: (err) => {
      logger.warn(
        { event: 'daemon-shutdown-for-upgrade.error', err: String(err) },
        'shutdownForUpgrade marker / drain failed; supervisor will fall back to force-kill',
      );
    },
  },
});
logger.info(
  {
    event: 'daemon.boot.supervisor-rpcs-wired',
    methods: supervisorWiringManifest.registered,
    healthzVersion: supervisorWiringManifest.schemaVersions.healthzVersion,
    statsVersion: supervisorWiringManifest.schemaVersions.statsVersion,
  },
  'supervisor RPCs wired',
);

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
  onConnection: (sock, peer) => {
    // Task #28 / B7a -- envelope adapter wires Duplex bytes into the
    // supervisor dispatcher. Adapter owns per-connection buffer
    // accumulation, frame decode (envelope/envelope.ts), schema validation
    // of the routing fields (id, method), and the socket.destroy() +
    // synthetic error reply on protocol violation per spec §3.4.1.a/d.
    mountEnvelopeAdapter({
      socket: sock,
      dispatcher: supervisorDispatcher,
      logger: { warn: (obj, msg) => logger.warn(obj, msg) },
      peer: 'control-socket',
      ...(peer?.pid !== undefined ? { peerPid: peer.pid } : {}),
    });
  },
});

dataSocket = createDataSocketServer({
  runtimeRoot: socketRuntimeRoot,
  ...(dataSocketPathOverride ? { socketPath: dataSocketPathOverride } : {}),
  logger: {
    warn: (obj, msg) => logger.warn(obj, msg),
  },
  onConnection: ({ socket, peer }) => {
    mountEnvelopeAdapter({
      socket,
      dispatcher: dataDispatcher,
      logger: { warn: (obj, msg) => logger.warn(obj, msg) },
      peer: 'data-socket',
      ...(peer?.pid !== undefined ? { peerPid: peer.pid } : {}),
    });
  },
});

// Boot the listeners. Wrapped in an async IIFE rather than top-level
// await because the daemon binary is produced by @yao-pkg/pkg via an
// esbuild → CJS bundle pipeline (frag-11 §11.1, spike Fallback A in
// docs/spikes/2026-05-pkg-esm-connect.md), and esbuild refuses to
// transform top-level await to CJS. Behaviour is identical: any reject
// re-throws to the crash handler; signal handlers below are still
// registered synchronously at module evaluation time.
void (async (): Promise<void> => {
  // Step 1 (frag-6-7 §6.4): acquire the daemon-singleton lockfile
  // BEFORE binding sockets / touching the data dir. A racing second
  // daemon throws `LockfileBusyError` here and exits non-zero; an
  // EROFS / read-only mount throws `LockfileFatalError` → exit(78)
  // (sysexits.h EX_CONFIG). Stale-PID recovery is internal to
  // `acquireDaemonLock`.
  try {
    lockHandle = await acquireDaemonLock({
      dataRoot,
      logger: {
        info: (obj, msg) => logger.info(obj, msg),
        warn: (obj, msg) => logger.warn(obj, msg),
        error: (obj, msg) => logger.error(obj, msg),
      },
    });
  } catch (err) {
    if (err instanceof LockfileBusyError) {
      // Pre-pino-flush stderr line per frag-6-7 §6.4 "Lockfile
      // create-fail policy" — surfaces even if pino's async dest
      // hasn't drained.
      process.stderr.write(
        `daemon.lock held by live PID ${err.holderPid}; another daemon is running\n`,
      );
      logger.error(
        { event: 'lockfile_busy', holder_pid: err.holderPid, path: err.path },
        'daemon already running; exiting',
      );
      // Exit code 75 (sysexits.h EX_TEMPFAIL) — supervisor's
      // spawn-or-attach (§6.1) treats this as "attach to existing
      // holder" rather than entering the crash-loop counter.
      process.exit(75);
    }
    if (err instanceof LockfileFatalError) {
      process.stderr.write(
        `daemon lockfile site unwritable (${err.code}) at ${err.path}; refusing to boot\n`,
      );
      // The acquire path already emitted `lockfile_erofs_fatal`. Exit
      // EX_CONFIG (78) — supervisor surfaces the configuration-error
      // modal rather than retry.
      process.exit(LOCKFILE_FATAL_EXIT_CODE);
    }
    // Unknown error → re-throw into the crash handler.
    throw err;
  }

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

  // Task #145 — start aggregate disk-cap watchdog (frag-6-7 §6.5).
  // Logs cap 500 MB, crashes cap 200 MB. Tick 60 s. Stopped in
  // shutdownDriver.exitProcess so it cannot fire during pino flush.
  const logsDir = path.join(runtimeRoot, 'logs');
  const crashesDir = path.join(runtimeRoot, 'crash');
  for (const d of [logsDir, crashesDir]) {
    try {
      await fs.promises.mkdir(d, { recursive: true });
    } catch (err) {
      logger.warn(
        { event: 'daemon.boot.disk-cap-mkdir-failed', dir: d, err: String(err) },
        'disk-cap watchdog target dir mkdir failed; watchdog will skip on first tick',
      );
    }
  }
  diskCapWatchdog = startDiskCapWatchdog({
    targets: [
      { dir: logsDir, capBytes: DEFAULT_LOGS_CAP_BYTES },
      { dir: crashesDir, capBytes: DEFAULT_CRASHES_CAP_BYTES },
    ],
    tickMs: DEFAULT_DISK_CAP_TICK_MS,
    onTick: (report) => {
      if (report.evictedFiles.length === 0) return;
      logger.info(
        {
          event: 'daemon.disk-cap.evict',
          dir: report.dir,
          capBytes: report.capBytes,
          totalBytesBefore: report.totalBytesBefore,
          totalBytesAfter: report.totalBytesAfter,
          evicted: report.evictedFiles.length,
        },
        'disk-cap watchdog evicted oldest files to bring directory under cap',
      );
    },
    onError: (err, ctx) => {
      logger.warn(
        { event: 'daemon.disk-cap.error', dir: ctx.dir, phase: ctx.phase, err: String(err) },
        'disk-cap watchdog tick failed; continuing',
      );
    },
  });
  logger.info(
    {
      event: 'daemon.boot.disk-cap-watchdog-started',
      tickMs: DEFAULT_DISK_CAP_TICK_MS,
      logsCapBytes: DEFAULT_LOGS_CAP_BYTES,
      crashesCapBytes: DEFAULT_CRASHES_CAP_BYTES,
    },
    'disk-cap watchdog armed',
  );
})();

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
