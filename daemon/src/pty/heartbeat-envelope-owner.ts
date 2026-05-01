// T48 wiring — heartbeat envelope owner.
//
// Composes the T42 stream-heartbeat scheduler with the T48 fromBootNonce
// stamper helper so heartbeat envelopes correctly carry the daemon's
// per-boot nonce on every tick.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//     §3.5.1.4 (line 101): "Daemon emits a `{ kind: 'heartbeat', ts,
//     traceId, bootNonce }` envelope on every server-stream every
//     `heartbeatMs`."
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.5: `bootNonce` is the same camelCase ULID surfaced on
//     `/healthz`, in `daemon.hello`, and on every PTY-stream heartbeat
//     / chunk-frame envelope. Single source of truth =
//     `daemon/src/index.ts` mints it via `ulid()` at module load.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   - PRODUCER role: the owner BUILDS the heartbeat envelope on every
//     tick (per-subId). The envelope is the only thing this module
//     constructs. The stamper attaches `bootNonce`; the owner attaches
//     `kind: 'heartbeat'` + `ts`.
//   - DECIDER role: NONE. The scheduler owns timing; the stamper owns
//     the nonce; this module is pure composition.
//   - SINK role: NONE. The owner does not write sockets — the wiring
//     layer (data-socket transport / fanout broadcast) supplies the
//     per-subId `push(envelope)` callback.
//
// Why this module exists (and is separate from the scheduler):
//   - The scheduler is intentionally envelope-shape-agnostic
//     (frag-3.5.1 §3.5.1.4 reservation: `sendHeartbeat` is INJECTED).
//   - The stamper is a pure helper bound to one nonce.
//   - Wiring the two together is the only place that knows BOTH (a) the
//     daemon-bound nonce and (b) the heartbeat envelope contract.
//   - Per `feedback_single_responsibility` we keep that knowledge in
//     one named seam instead of inlining it at the daemon shell —
//     so tests can assert "envelope shape × stamping × tick cadence"
//     in isolation, without spinning a real dispatcher / transport.

import {
  createFromBootNonceStamper,
  type BootNonce,
  type FromBootNonceStamper,
} from './from-boot-nonce-stamper.js';
import {
  createHeartbeatScheduler,
  type HeartbeatScheduler,
  type HeartbeatSchedulerOptions,
  type SubscriberId,
} from './stream-heartbeat-scheduler.js';

/**
 * The heartbeat envelope shape produced by the owner. Mirrors the
 * frag-3.5.1 §3.5.1.4 line 101 wire contract:
 *
 *   { kind: 'heartbeat', ts, bootNonce }
 *
 * `traceId` from the spec line 101 quote is per-subscriber context that
 * the wiring layer (data-socket transport) attaches at envelope-write
 * time — heartbeats are not RPC requests with their own traceId; they
 * piggyback the subscribe call's traceId. Keeping it OUT of the owner
 * mirrors the scheduler's "no envelope encoding" non-goal.
 *
 * The `bootNonce` field is REQUIRED on the output (project convention:
 * required > optional for wire fields the consumer must trust).
 */
export interface HeartbeatEnvelope {
  readonly kind: 'heartbeat';
  readonly ts: number;
  readonly bootNonce: BootNonce;
}

/**
 * Per-subId push callback supplied by the wiring layer (data-socket
 * transport / fanout broadcast). Invoked once per scheduled tick with
 * the freshly-stamped heartbeat envelope. Fire-and-forget — the owner
 * does NOT inspect the return value (heartbeats are best-effort; the
 * symmetric T44 stream-dead-detector handles missed liveness).
 */
export type PushHeartbeat = (subId: SubscriberId, envelope: HeartbeatEnvelope) => void;

/**
 * Construction options for the heartbeat envelope owner. Mirrors the
 * scheduler's options minus `sendHeartbeat` (the owner provides its
 * own `sendHeartbeat` to the underlying scheduler) plus the stamper
 * inputs (either a bootNonce string OR a pre-built stamper instance,
 * to support the daemon shell's "single source of truth" pattern
 * where one stamper is shared with other PTY producers).
 */
export interface HeartbeatEnvelopeOwnerOptions
  extends Omit<HeartbeatSchedulerOptions, 'sendHeartbeat'> {
  /**
   * Per-subId push callback. The wiring layer adapts this to its
   * transport (e.g. `(subId, env) => fanoutRegistry.broadcast(subId, env)`
   * or `(subId, env) => streamMap.get(subId)?.push(env)`).
   */
  readonly push: PushHeartbeat;

  /**
   * Daemon-bound boot nonce. Mutually exclusive with `stamper`. When
   * supplied, the owner builds its own stamper internally via
   * `createFromBootNonceStamper(bootNonce)`. Use this in the daemon
   * shell when the owner is the sole consumer of the stamper.
   */
  readonly bootNonce?: BootNonce;

  /**
   * Pre-built stamper instance. Mutually exclusive with `bootNonce`.
   * Use this when the daemon shell already constructed a stamper for
   * other PTY producers (chunk fan-out, snapshot RPC) — sharing the
   * same instance guarantees one nonce across all PTY emissions.
   */
  readonly stamper?: FromBootNonceStamper;
}

/**
 * Public surface — start / stop heartbeats per subId, plus
 * `updateInterval` proxied through to the underlying scheduler. Tests
 * also get `running()` / `ticks()` via the same proxy so the existing
 * scheduler test conventions carry over.
 */
export interface HeartbeatEnvelopeOwner {
  start(subId: SubscriberId): void;
  stop(subId: SubscriberId): void;
  updateInterval(newMs: number): void;
  running(): number;
  ticks(): number;
}

/**
 * Construct the owner. The daemon shell instantiates ONCE per daemon
 * process at PTY stream wiring init time:
 *
 *   import { bootNonce } from './index.js';
 *   const owner = createHeartbeatEnvelopeOwner({
 *     bootNonce,
 *     intervalMs: negotiatedHeartbeatMs,
 *     push: (subId, env) => transport.pushToSub(subId, env),
 *   });
 *   transport.onSubscribe((subId) => owner.start(subId));
 *   transport.onUnsubscribe((subId) => owner.stop(subId));
 */
export function createHeartbeatEnvelopeOwner(
  opts: HeartbeatEnvelopeOwnerOptions,
): HeartbeatEnvelopeOwner {
  if (typeof opts.push !== 'function') {
    throw new TypeError(
      'heartbeat-envelope-owner: push callback is required',
    );
  }
  if (opts.bootNonce !== undefined && opts.stamper !== undefined) {
    throw new TypeError(
      'heartbeat-envelope-owner: pass either bootNonce or stamper, not both',
    );
  }
  if (opts.bootNonce === undefined && opts.stamper === undefined) {
    throw new TypeError(
      'heartbeat-envelope-owner: bootNonce or stamper is required',
    );
  }

  // Resolve the stamper. Either branch yields a FromBootNonceStamper
  // bound to ONE per-boot value — never null, never re-bound.
  const stamper: FromBootNonceStamper =
    opts.stamper ?? createFromBootNonceStamper(opts.bootNonce as BootNonce);

  // Clock injection mirrors the scheduler's symmetry. We use it for the
  // envelope `ts` field — NOT for tick scheduling (the scheduler's
  // timer hooks own that). Defaults to `Date.now`.
  const now = opts.now ?? Date.now;
  const push = opts.push;

  // The `sendHeartbeat` callback we hand to the scheduler is the actual
  // wiring point: on every tick, build the envelope, stamp the nonce,
  // and forward to the transport-supplied push.
  function sendHeartbeat(subId: SubscriberId): void {
    // Build the base envelope WITHOUT the nonce so the stamper has a
    // single chosen seam to attach it. Order matters: the stamper's
    // `stamp()` spreads the daemon-bound value LAST, so even if a
    // future refactor accidentally pre-fills `bootNonce`, the daemon
    // value wins (matches `boot-nonce-precedence.ts` posture).
    const base = { kind: 'heartbeat' as const, ts: now() };
    const envelope: HeartbeatEnvelope = stamper.stamp(base);
    push(subId, envelope);
  }

  // Hand the composed sendHeartbeat to the underlying scheduler. The
  // scheduler swallows throws on the per-tick path, so a bad transport
  // for one subId cannot starve the others — same posture as the
  // scheduler's hard non-goal note.
  const scheduler: HeartbeatScheduler = createHeartbeatScheduler({
    intervalMs: opts.intervalMs,
    now: opts.now,
    timers: opts.timers,
    sendHeartbeat,
  });

  return {
    start: (subId) => scheduler.start(subId),
    stop: (subId) => scheduler.stop(subId),
    updateInterval: (newMs) => scheduler.updateInterval(newMs),
    running: () => scheduler.running(),
    ticks: () => scheduler.ticks(),
  };
}
