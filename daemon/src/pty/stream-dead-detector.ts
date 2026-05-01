// Per-subscriber liveness detector for the PTY fan-out path.
//
// Spec: docs/superpowers/specs/v0.3-design.md
//   - frag-3.5.1 §3.5.1.4 — client-side dead-stream detection at
//     `2 × heartbeatMs + 5 s`; cross-frag handoff notes the symmetric
//     server-side detector lives in §6.5.1.
//   - frag-6-7 §6.5.1 (lines 1695-1714) — canonical server-side
//     stream-dead detector (round-7 manager lock, r6 reliability
//     P0-R2). Daemon maintains a per-stream `lastClientActivityAt`
//     timestamp; the shared heartbeat scheduler (already iterating
//     once per second) checks `now - lastClientActivityAt
//     > 2 × heartbeatMs + 5_000` and treats the stream + connection as
//     dead. The v0.3 local-pipe / unix-socket transport makes this a
//     no-op in practice (kernel `'close'` fires first), but the
//     contract is byte-compatible with the v0.5 CF Tunnel TCP swap
//     where half-open sockets need an application-layer detector.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   - PRODUCER: `onAck(subscriberId)` — caller feeds liveness signals
//     (any inbound RPC on the same connection per spec line 1701, or
//     any client frame on the same connection in v0.5).
//   - DECIDER: `check(now)` — pure function over the in-memory map;
//     returns the list of subscriber ids whose `lastAck` is older than
//     `deadlineMs`. **Does NOT** close sockets, **does NOT** unsubscribe
//     from the fan-out registry (frag-3.5.1 §3.5.1.5 / `fanout-registry.ts`),
//     **does NOT** emit log lines. The shared heartbeat scheduler that
//     wires this up owns those side effects (spec §6.5.1 step 2-4).
//   - This is NOT a sink. The wiring layer (T42 producer / shared
//     heartbeat scheduler) is responsible for translating the returned
//     ids into `subscriber-dropped` log lines + registry `unsubscribe`
//     calls + `socket.destroy()`.
//
// Hard non-goals (push back if asked):
//   - No socket I/O, no log emission, no registry coupling.
//   - No heartbeat **sending** — that lives in the T42 shared heartbeat
//     scheduler. This module only detects subscribers that have stopped
//     ack'ing (i.e. liveness from the OTHER direction).
//   - No deadline arithmetic against `2 × heartbeatMs + 5_000` — the
//     caller computes `deadlineMs` from the negotiated heartbeat
//     interval and passes it in. Keeping the formula at the wiring
//     layer means a single source of truth even if the heartbeat
//     interval is renegotiated mid-stream (frag-3.4.1 §3.4.1.c
//     `x-ccsm-heartbeat-ms`).

/**
 * Opaque subscriber identifier. The detector treats ids as bare
 * strings — it never inspects shape or relates them to the fan-out
 * registry's `Subscriber` object identity. Callers pick the id space
 * (e.g. monotonic stream id from the dispatcher) and feed the same
 * id to `onAck` and observe it in `check()` output.
 */
export type SubscriberId = string;

/**
 * Options for `createStreamDeadDetector`.
 */
export interface StreamDeadDetectorOptions {
  /**
   * The liveness window in milliseconds. A subscriber whose most recent
   * `onAck` (or, if none, its registration timestamp) is older than
   * `deadlineMs` at the moment `check(now)` is called is considered
   * dead and returned by `check()`.
   *
   * Per spec §6.5.1 the canonical wiring uses
   * `2 × heartbeatMs + 5_000` — but the formula stays at the caller so
   * this module is decoupled from the heartbeat interval.
   *
   * Must be a positive finite integer.
   */
  deadlineMs: number;
  /**
   * Optional clock injection for hermetic tests. Defaults to `Date.now`.
   * Production wiring may pass a monotonic clock if it ever wants to
   * decouple from wall-clock NTP jumps; v0.3 has no such requirement.
   */
  now?: () => number;
}

export interface StreamDeadDetector {
  /**
   * Mark `subscriberId` as freshly observed at `now()` (or at the
   * timestamp passed in). Idempotent. Implicitly registers the
   * subscriber if not yet known — this means the first `onAck` after
   * subscribe acts as a re-arm; callers that want to start the deadline
   * clock at registration time should additionally call `track()`.
   */
  onAck(subscriberId: SubscriberId, at?: number): void;
  /**
   * Begin tracking `subscriberId` with `lastAck = at ?? now()` without
   * counting it as a fresh ack. Used by the wiring layer at subscribe
   * time so a subscriber that never ack'ed still trips the detector
   * after `deadlineMs`. Idempotent — re-tracking an already-tracked id
   * is a no-op (does NOT bump the timestamp; use `onAck` for that).
   */
  track(subscriberId: SubscriberId, at?: number): void;
  /**
   * Stop tracking `subscriberId`. Used by the wiring layer when the
   * subscriber leaves voluntarily (registry `unsubscribe`) or when
   * `check()` flagged it dead and the caller has finished tearing
   * down. Idempotent — untracking an unknown id is a no-op.
   */
  forget(subscriberId: SubscriberId): void;
  /**
   * Return the sorted list of subscriber ids whose `lastAck` (or
   * `track()` timestamp) is **strictly older** than `now - deadlineMs`.
   * Pure read — does NOT mutate the internal map; callers MUST call
   * `forget()` after acting on the returned ids, or the next tick will
   * return the same ids again.
   *
   * Sort is ASCII lexical on the id, deterministic for tests and for
   * the spec §6.5.1 single-aggregated-log-line requirement.
   *
   * @param now - timestamp to compare against; defaults to the
   *   detector's clock (`opts.now ?? Date.now`). Tests pass an explicit
   *   value for hermeticity.
   */
  check(now?: number): SubscriberId[];
  /**
   * Number of currently-tracked subscribers. For tests + diagnostics
   * only; no spec contract.
   */
  size(): number;
}

/**
 * Create a fresh stream-dead detector. The daemon process holds one
 * instance shared across all PTY sessions (the shared heartbeat
 * scheduler at frag-3.5.1 §3.5.1.4 is also process-wide); tests
 * typically create a fresh instance per case.
 */
export function createStreamDeadDetector(
  opts: StreamDeadDetectorOptions,
): StreamDeadDetector {
  if (
    !Number.isFinite(opts.deadlineMs) ||
    !Number.isInteger(opts.deadlineMs) ||
    opts.deadlineMs <= 0
  ) {
    throw new RangeError(
      `stream-dead-detector: deadlineMs must be a positive integer, got ${String(opts.deadlineMs)}`,
    );
  }
  const deadlineMs = opts.deadlineMs;
  const clock = opts.now ?? Date.now;

  // subscriberId -> last-ack timestamp (ms). Map iteration order is
  // insertion order in JS, but we sort lexically in `check()` so the
  // wiring-layer aggregated log line is deterministic across runs.
  const lastAck = new Map<SubscriberId, number>();

  function onAck(subscriberId: SubscriberId, at?: number): void {
    lastAck.set(subscriberId, at ?? clock());
  }

  function track(subscriberId: SubscriberId, at?: number): void {
    if (lastAck.has(subscriberId)) return;
    lastAck.set(subscriberId, at ?? clock());
  }

  function forget(subscriberId: SubscriberId): void {
    lastAck.delete(subscriberId);
  }

  function check(now?: number): SubscriberId[] {
    const t = now ?? clock();
    const cutoff = t - deadlineMs;
    const dead: SubscriberId[] = [];
    for (const [id, ts] of lastAck) {
      if (ts < cutoff) dead.push(id);
    }
    // Stable lexical sort — single aggregated log line in spec §6.5.1
    // wants reproducible ordering across daemon restarts so log
    // grepping works.
    dead.sort();
    return dead;
  }

  function size(): number {
    return lastAck.size;
  }

  return { onAck, track, forget, check, size };
}
