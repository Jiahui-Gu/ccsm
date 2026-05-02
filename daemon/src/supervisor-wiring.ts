// Supervisor-plane RPC wiring (Task #100, re-instatement of #69).
//
// Per audit 4 finding F8: the spec defines SUPERVISOR_RPCS for daemon
// liveness/supervision (frag-3.4.1 §3.4.1.h, frag-6-7 §6.5), and individual
// pure handlers landed across T17–T21, but the daemon shell (`index.ts`) only
// wired one (`daemon.shutdown`) into the live `supervisorDispatcher`. The
// other handlers were reachable via the dispatcher allowlist but every call
// short-circuited to `NOT_IMPLEMENTED` because the stubs were never replaced.
//
// This module replaces those stubs with the real handlers, gathered behind one
// dependency-injected entry point so:
//   1. the daemon shell stays a thin sink (it just builds the deps and calls
//      `wireSupervisorDispatcher`);
//   2. the wiring is unit-testable without spawning a daemon process —
//      `__tests__/supervisor-wiring.test.ts` exercises every registered slot
//      against a fake clock + in-memory marker dir;
//   3. additional supervisor RPCs (e.g. a future `daemon.hello` keystore
//      wiring) plug in here without further surgery on `index.ts`.
//
// Single Responsibility:
//   - DECIDER: chooses which handler factory to call for each method name.
//   - SINK: registers the resulting handler against the dispatcher.
//   - PRODUCER: none — all runtime values arrive via `WireSupervisorDeps`.
//
// Constraint (Task #100 brief): explicitly does NOT couple to the hello-HMAC
// handshake. The HMAC verification interceptor is being decoupled separately;
// supervisor-plane handlers must be reachable on the envelope plane WITHOUT
// requiring HMAC. The handlers wired here perform no HMAC work; `daemon.hello`
// stays as the existing NOT_IMPLEMENTED stub until the secret-loading slice
// lands and the keystore call site is decided.
//
// Spec citations:
//   - frag-3.4.1 §3.4.1.h SUPERVISOR_RPCS allowlist (canonical method set).
//   - frag-6-7 §6.5 `/healthz` + `/stats` shapes; supervisor pings `/healthz`
//     every 5 s on the dedicated control transport (three consecutive misses
//     → restart).
//   - frag-6-7 §6.4 `daemon.shutdownForUpgrade` marker contract.
//   - frag-6-7 §6.6.1 ordered shutdown sequence (driven by `daemon.shutdown`,
//     wired upstream in `index.ts` against the per-subsystem sinks; we adopt
//     the existing handler instance here so wiring stays in one place).

import type { Dispatcher, Handler } from './dispatcher.js';
import {
  HEALTHZ_VERSION,
  makeHealthzHandler,
  type HealthzContext,
} from './handlers/healthz.js';
import {
  STATS_VERSION,
  makeStatsHandler,
  defaultMemoryUsageProvider,
  type StatsContext,
} from './handlers/stats.js';
import {
  defaultWriteShutdownMarker,
  makeShutdownForUpgradeHandler,
  type ShutdownForUpgradeActions,
  type ShutdownForUpgradeContext,
} from './handlers/daemon-shutdown-for-upgrade.js';

/** Method names this module wires onto the supervisor dispatcher. Mirrors the
 *  keys in `SUPERVISOR_RPCS` minus `daemon.hello` (deferred — see file
 *  comment) and `daemon.shutdown` (wired by the daemon shell because it
 *  binds the per-subsystem shutdown sinks the shell owns). */
export const WIRED_SUPERVISOR_METHODS = [
  '/healthz',
  '/stats',
  'daemon.shutdownForUpgrade',
] as const;

export type WiredSupervisorMethod = (typeof WIRED_SUPERVISOR_METHODS)[number];

/** Live dependencies the daemon shell injects when wiring the dispatcher.
 *  Each field maps 1:1 to one handler's context — keeping them split lets
 *  tests stub a single handler without faking the whole boot context. */
export interface WireSupervisorDeps {
  /** Healthz context (frag-6-7 §6.5). The shell owns the live counter
   *  providers (session count, subscriber count, migration FSM, swap flag)
   *  and forwards them through this object. `bootedAtMs` MUST be captured
   *  ONCE at boot so `uptimeMs` is monotonic across calls. */
  readonly healthz: HealthzContext;
  /** Stats context (frag-6-7 §6.5). Memory usage falls back to
   *  `defaultMemoryUsageProvider()` if the shell does not pre-build one. */
  readonly stats: Omit<StatsContext, 'getMemoryUsage'> & {
    readonly getMemoryUsage?: StatsContext['getMemoryUsage'];
  };
  /** Shutdown-for-upgrade context (frag-6-7 §6.4). `markerDir` MUST be the
   *  same `runtimeRoot` the supervisor's marker reader (T22) probes. */
  readonly shutdownForUpgrade: {
    readonly ctx: ShutdownForUpgradeContext;
    /** Sink-side actions. Defaults: real `defaultWriteShutdownMarker`,
     *  caller-supplied `runShutdownSequence` / `releaseLock` / `exit`.
     *  Tests inject all four; production wires the real fs + lockfile +
     *  process.exit. */
    readonly actions: ShutdownForUpgradeActions;
    /** Optional sink for marker-write / drain failures. Production wires
     *  pino.warn; tests record into an array. */
    readonly onError?: (err: unknown) => void;
  };
}

export interface WireSupervisorResult {
  /** Methods that were registered (in declaration order). Returned so the
   *  caller can log a single boot line listing the live supervisor RPCs
   *  without re-deriving the set. */
  readonly registered: ReadonlyArray<WiredSupervisorMethod>;
  /** Schema version cursors surfaced for the boot log. Lets the daemon
   *  emit one structured line a forensic reader can grep without loading
   *  the handler modules. */
  readonly schemaVersions: {
    readonly healthzVersion: typeof HEALTHZ_VERSION;
    readonly statsVersion: typeof STATS_VERSION;
  };
}

/**
 * Replace the NOT_IMPLEMENTED stubs on a freshly-built supervisor dispatcher
 * (`createSupervisorDispatcher()`) with the real handlers for `/healthz`,
 * `/stats`, and `daemon.shutdownForUpgrade`.
 *
 * Idempotent at the dispatcher level — `Dispatcher.register` overwrites any
 * prior handler — but this function is intended to run exactly once per boot.
 * Calling it twice on the same dispatcher would re-register the handlers
 * with whatever `deps` the second call carries; tests that exercise the
 * boot flow should construct a fresh dispatcher per case.
 *
 * Returns a manifest the caller can log + assert against in tests. Does NOT
 * touch `daemon.hello` (HMAC keystore is a separate slice) or `daemon.shutdown`
 * (the shell wires that itself because it owns the per-subsystem sinks).
 */
export function wireSupervisorDispatcher(
  dispatcher: Dispatcher,
  deps: WireSupervisorDeps,
): WireSupervisorResult {
  // /healthz — pure decider; never throws, even on clock-rewind.
  const healthzHandler: Handler = async (req) => {
    return makeHealthzHandler(deps.healthz)(req);
  };
  dispatcher.register('/healthz', healthzHandler);

  // /stats — diagnostic-grade snapshot (rss / heapUsed / pty buffer / sockets).
  const statsCtx: StatsContext = {
    getMemoryUsage: deps.stats.getMemoryUsage ?? defaultMemoryUsageProvider(),
    ...(deps.stats.getPtyBufferBytes ? { getPtyBufferBytes: deps.stats.getPtyBufferBytes } : {}),
    ...(deps.stats.getOpenSockets ? { getOpenSockets: deps.stats.getOpenSockets } : {}),
  };
  const statsHandler: Handler = async (req) => {
    return makeStatsHandler(statsCtx)(req);
  };
  dispatcher.register('/stats', statsHandler);

  // daemon.shutdownForUpgrade — atomic marker write + ordered drain + exit(0).
  const upgradeHandler = makeShutdownForUpgradeHandler(
    deps.shutdownForUpgrade.ctx,
    deps.shutdownForUpgrade.actions,
    deps.shutdownForUpgrade.onError,
  );
  dispatcher.register('daemon.shutdownForUpgrade', upgradeHandler);

  return {
    registered: [...WIRED_SUPERVISOR_METHODS],
    schemaVersions: {
      healthzVersion: HEALTHZ_VERSION,
      statsVersion: STATS_VERSION,
    },
  };
}

/** Production default for `shutdownForUpgrade.actions.writeMarker`. Re-exported
 *  so the daemon shell can build the actions object without importing the
 *  handler module directly. */
export { defaultWriteShutdownMarker };
