// /healthz handler (T17) — control-socket liveness probe.
//
// Spec citations:
//   - frag-6-7 §6.5 "Health probe + dedicated supervisor transport" — canonical
//     owner of the response payload shape.
//   - frag-3.4.1 §3.4.1.h — `/healthz` is a wire-literal control-plane RPC
//     (NOT `ccsm.v1/daemon.healthz`); registered on the control-socket
//     dispatcher (T16) as the literal string.
//   - frag-3.4.1 §3.4.1.f — supervisor transport is the SINGLE channel that
//     ignores `MIGRATION_PENDING` short-circuit; `/healthz` ALWAYS returns a
//     liveness body, never a sentinel error. The body carries `migrationState`
//     so the supervisor can observe the migration window inline.
//
// Response shape (frag-6-7 §6.5):
//   { uptimeMs, pid, version, bootNonce, sessionCount, subscriberCount,
//     migrationState, swapInProgress,
//     protocol: { wire, minClient, daemonProtocolVersion, daemonAcceptedWires,
//                 features },
//     healthzVersion: 1 }
//
// Single Responsibility: pure decider. Reads injected boot context + counter
// providers, returns a snapshot. Performs ZERO socket I/O and ZERO database
// queries (per §6.5 "Cheap (~50µs)" budget — three consecutive misses inside
// a 15 s window restart the daemon, so the handler MUST stay branch-free of
// any path that can block).
//
// The boot-time / counter providers are injected so:
//   1. The daemon shell (T1 / index.ts) owns the live values; this module
//      stays a pure function and is trivially testable with a fake clock.
//   2. T18-T21 (other supervisor RPCs) and the dispatcher wiring (T16) can
//      build the context once at boot and share it across handlers.
//   3. v0.4 protobuf swap can reuse the handler verbatim — only the wire
//      serialiser changes.

import { DAEMON_PROTOCOL_VERSION } from '../envelope/protocol-version.js';

/** Migration FSM states surfaced via `/healthz` (frag-6-7 §6.5 + frag-8 §8.5).
 *  v0.3 ships SQLite migration; the four states are the canonical FSM. */
export type MigrationState = 'absent' | 'pending' | 'in-progress' | 'done';

/** Wire-literal canonical for v0.3 (frag-3.4.1 §3.4.1.g). */
export const HEALTHZ_WIRE = 'v0.3-json-envelope' as const;

/** Lowest client wire-version this daemon will negotiate (frag-3.4.1 §3.4.1.g). */
export const HEALTHZ_MIN_CLIENT = 'v0.3' as const;

/** v0.3 daemon accepts only the v0.3 envelope (frag-3.4.1 §3.4.1.g r3 P1-5).
 *  v0.4 will append `'v0.4-protobuf'` during the rolling-upgrade window. */
export const HEALTHZ_DAEMON_ACCEPTED_WIRES = [
  'v0.3-json-envelope',
] as const;

/** Feature advertisement string list — additive evolution (frag-6-7 §6.5,
 *  matches the `protocol.features` array embedded in `daemon.hello` reply per
 *  frag-3.4.1 §3.4.1.g and §6.5.1 mirror rule). */
export const HEALTHZ_FEATURES = [
  'binary-frames',
  'stream-heartbeat',
  'interceptors',
  'traceId',
  'bootNonce',
  'hello',
] as const;

/** Healthz schema-version cursor (frag-6-7 §6.5 r3 P1-3). Bumps only on
 *  breaking shape changes; additive fields do NOT bump it (consumers MUST
 *  treat unknown fields as forward-compatible per frag-3.4.1 §3.4.1.g rule).
 *  v0.3 = 1. */
export const HEALTHZ_VERSION = 1 as const;

/** Injected boot/runtime context. The daemon shell (T1) owns the live values
 *  and constructs this once; the handler reads only — no mutation here. */
export interface HealthzContext {
  /** Crockford ULID minted at daemon boot (frag-6-7 §6.5 r3 CF-2 lock —
   *  camelCase across all fragments; ULID, NOT `Date.now()`). */
  readonly bootNonce: string;
  /** Daemon process PID (frag-6-7 §6.5). */
  readonly pid: number;
  /** Semver-string of the daemon binary (frag-6-7 §6.5 `version` field). */
  readonly version: string;
  /** Monotonic boot time in milliseconds since epoch — captured ONCE at boot
   *  (frag-6-7 §6.5: the supervisor uses `uptimeMs` to detect daemon restart
   *  AND validate clock-skew against its own boot wall-clock). */
  readonly bootedAtMs: number;
  /** Clock for `now` — injected so tests can advance time deterministically.
   *  Production = `() => Date.now()`. */
  readonly now: () => number;
  /** Live session count snapshot (frag-6-7 §6.5). 0 until the session
   *  registry (frag-3.5.1) is wired; T17 ships a default-0 producer so the
   *  field is always present on the wire. */
  readonly getSessionCount?: () => number;
  /** Live stream-subscriber count snapshot (frag-3.5.1 §3.5.1.4 fan-out
   *  registry). 0 until wired (see `getSessionCount`). */
  readonly getSubscriberCount?: () => number;
  /** Migration FSM read-side. Default `'absent'` (no migration ever ran on a
   *  fresh install). frag-8 §8.5 owns the producer. */
  readonly getMigrationState?: () => MigrationState;
  /** Auto-update swap window flag (frag-6-7 §6.4 step 4-7 + §6.5 r3 sec
   *  P1-6). When true, supervisor pauses imposter-secret HMAC verification. */
  readonly getSwapInProgress?: () => boolean;
}

/** Frozen `protocol` block returned inside the healthz body (frag-6-7 §6.5).
 *  Mirrored 1:1 in the `daemon.hello` reply — same constants, no drift. */
export interface HealthzProtocolBlock {
  readonly wire: typeof HEALTHZ_WIRE;
  readonly minClient: typeof HEALTHZ_MIN_CLIENT;
  readonly daemonProtocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly daemonAcceptedWires: ReadonlyArray<string>;
  readonly features: ReadonlyArray<string>;
}

/** Full `/healthz` response shape (frag-6-7 §6.5 lines 124-140). */
export interface HealthzReply {
  readonly uptimeMs: number;
  readonly pid: number;
  readonly version: string;
  readonly bootNonce: string;
  readonly sessionCount: number;
  readonly subscriberCount: number;
  readonly migrationState: MigrationState;
  readonly swapInProgress: boolean;
  readonly protocol: HealthzProtocolBlock;
  readonly healthzVersion: typeof HEALTHZ_VERSION;
}

/**
 * Build the canonical `/healthz` reply.
 *
 * Pure: same `(req, ctx)` always yields the same output for the same clock
 * value. Performs no I/O, never throws on a well-formed context.
 *
 * The `req` argument is intentionally unused — `/healthz` takes no parameters
 * per frag-6-7 §6.5 (supervisor pings with an empty payload). Accepting it as
 * a Handler-compatible signature keeps wiring trivial for T16.
 */
export function handleHealthz(_req: unknown, ctx: HealthzContext): HealthzReply {
  // Clamp uptime to >=0 — protects against pathological clock-rewind cases
  // where an injected `now()` returns a value below `bootedAtMs` (NTP step,
  // hibernate-resume on Win 11). Spec assumes monotonic; we clamp instead of
  // throwing because /healthz must never error (§6.5 "always returns liveness").
  const rawUptime = ctx.now() - ctx.bootedAtMs;
  const uptimeMs = rawUptime < 0 ? 0 : rawUptime;

  return {
    uptimeMs,
    pid: ctx.pid,
    version: ctx.version,
    bootNonce: ctx.bootNonce,
    sessionCount: ctx.getSessionCount?.() ?? 0,
    subscriberCount: ctx.getSubscriberCount?.() ?? 0,
    migrationState: ctx.getMigrationState?.() ?? 'absent',
    swapInProgress: ctx.getSwapInProgress?.() ?? false,
    protocol: {
      wire: HEALTHZ_WIRE,
      minClient: HEALTHZ_MIN_CLIENT,
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      daemonAcceptedWires: HEALTHZ_DAEMON_ACCEPTED_WIRES,
      features: HEALTHZ_FEATURES,
    },
    healthzVersion: HEALTHZ_VERSION,
  };
}

/** Adapter to the T16 `Dispatcher.Handler` signature. T16's handler returns
 *  `Promise<unknown>`; healthz is synchronous but we wrap so `register()`
 *  accepts it without coupling the pure function to Promise plumbing.
 *
 *  Usage (post-T16-merge follow-up commit):
 *    dispatcher.register('/healthz', makeHealthzHandler(ctx));
 */
export function makeHealthzHandler(
  ctx: HealthzContext,
): (req: unknown) => Promise<HealthzReply> {
  return async (req: unknown) => handleHealthz(req, ctx);
}
