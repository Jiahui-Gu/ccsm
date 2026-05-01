// Per-subscriber heartbeat sender for the PTY fan-out path.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//   - §3.5.1.4 — server-streaming RPCs (`ptySubscribe`,
//     `subscribeNotifications`, `subscribeSessionUpdates`) emit a
//     periodic heartbeat envelope so the client-side T44
//     stream-dead-detector + the v0.5 CF Tunnel half-open-socket
//     detector have a positive liveness signal even on idle streams.
//   - frag-6-7 §6.5.1 — the symmetric server-side dead-stream
//     detector uses the formula `2 × heartbeatMs + 5_000`. That
//     formula lives at the WIRING layer, not here and not in the
//     detector — so renegotiating `heartbeatMs` mid-stream needs no
//     detector restart (this scheduler picks up the new interval on
//     the next tick).
//   - frag-3.4.1 §3.4.1.c `x-ccsm-heartbeat-ms` envelope header
//     drives the negotiated interval. Default 30_000 ms; clamp range
//     5_000..300_000 ms (5 s..5 min) — below 5 s would beat the
//     local-pipe p99 budget, above 5 min would defeat the half-open
//     detector contract.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   - This module is a SCHEDULER (timing + lifecycle) only.
//   - PRODUCER role: the timer fires `sendHeartbeat(subId)` —
//     `sendHeartbeat` is INJECTED by the wiring layer. The scheduler
//     does not know how to transmit, what envelope shape to write,
//     which socket to write to, or how to mark the registry. All of
//     that lives in the caller (T48 fromBootNonce wiring is one such
//     caller).
//   - DECIDER role: NONE. There is no decision logic here — fixed
//     interval per subId, period adjustable via `updateInterval`.
//   - SINK role: NONE. No socket I/O, no log emission, no registry
//     coupling, no ack tracking (that is T44's stream-dead-detector).
//
// Hard non-goals (push back if asked):
//   - No socket writes — caller wires `sendHeartbeat` to fanout.
//   - No envelope construction — caller owns wire format.
//   - No detector coupling — the `2 × heartbeatMs + 5_000` formula
//     and the `lastClientActivityAt` map are NOT in this module.
//   - No log emission — schedule/cancel/tick events are silent;
//     production wiring may instrument by wrapping `sendHeartbeat`.
//   - No clamp policy in the sender path — clamp happens once at
//     `createHeartbeatScheduler` and again at `updateInterval`. We
//     do NOT silently coerce on every tick.

/**
 * Opaque subscriber identifier. Same id space as
 * `stream-dead-detector.SubscriberId`; the scheduler treats ids as
 * bare strings and never relates them to fan-out registry objects.
 */
export type SubscriberId = string;

/**
 * Default heartbeat interval per spec §3.5.1.4 (frag-3.4.1
 * `x-ccsm-heartbeat-ms` reservation).
 */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Inclusive lower clamp on the negotiated heartbeat interval.
 * 5 s — leaves headroom over local-pipe p99 (Task 7 acceptance
 * benchmark targets p95 < 5 ms) so the heartbeat path is never the
 * dominant traffic.
 */
export const MIN_HEARTBEAT_MS = 5_000;

/**
 * Inclusive upper clamp on the negotiated heartbeat interval.
 * 5 min — beyond this the half-open-socket detector window
 * (`2 × heartbeatMs + 5_000`) exceeds practical patience for a CF
 * Tunnel reconnection; v0.5 will revisit if the wire pricing model
 * changes.
 */
export const MAX_HEARTBEAT_MS = 300_000;

/**
 * Indirection over `setInterval` / `clearInterval` for hermetic tests
 * that do NOT want to enable `vi.useFakeTimers()` globally. If unset,
 * the scheduler falls back to the host `setInterval` / `clearInterval`
 * — vitest's fake timers patch those at the host level, so the common
 * test path still works without injecting anything.
 */
export interface TimerHooks {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface HeartbeatSchedulerOptions {
  /**
   * Initial heartbeat interval in milliseconds. Will be validated +
   * clamped to `[MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS]`. Defaults to
   * `DEFAULT_HEARTBEAT_MS` (30 s) if unset.
   */
  intervalMs?: number;
  /**
   * Wiring-layer transmit callback. Invoked once per scheduled tick
   * per active subId. The scheduler does NOT inspect the return
   * value, NOR await a returned Promise (heartbeats are
   * fire-and-forget — backpressure is the caller's drop-slowest
   * problem, not the scheduler's). Throws are caught and swallowed
   * so a single bad subscriber cannot starve the others on the
   * shared timer.
   */
  sendHeartbeat: (subId: SubscriberId) => void;
  /**
   * Optional clock injection (mirrors stream-dead-detector). The
   * scheduler does not actually consult the clock for tick timing
   * (the timer hook owns that) — `now` is exposed only for the
   * `ticks` counter's debug story. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Optional timer hook injection (see `TimerHooks`). Defaults to the
   * host `setInterval` / `clearInterval`.
   */
  timers?: TimerHooks;
}

export interface HeartbeatScheduler {
  /**
   * Begin emitting heartbeats for `subId`. Idempotent — calling
   * `start` on an already-running subId is a no-op (does NOT reset
   * the in-flight timer phase, does NOT double-schedule). The first
   * heartbeat fires after one full `intervalMs`, NOT immediately —
   * subscribe-time the wiring layer typically writes the snapshot
   * frame anyway, so an immediate heartbeat would be redundant.
   */
  start(subId: SubscriberId): void;
  /**
   * Stop emitting heartbeats for `subId`. Idempotent — stopping an
   * unknown subId is a silent no-op (matches `forget()` semantics on
   * the detector side: the wiring layer can fire stop on every
   * unsubscribe path without checking).
   */
  stop(subId: SubscriberId): void;
  /**
   * Replace the interval. Validates + clamps to
   * `[MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS]` (non-finite / non-integer
   * inputs throw `RangeError` — silent coercion would mask bugs in
   * the negotiation path). All currently-running subIds pick up the
   * new interval on their NEXT tick: the scheduler tears down each
   * timer and re-arms with the new period. Critically this does NOT
   * notify the T44 stream-dead-detector — per spec §6.5.1 the
   * detector formula lives at the wiring layer, so the wiring layer
   * is responsible for recomputing `deadlineMs` if it cares.
   */
  updateInterval(newMs: number): void;
  /**
   * Number of currently-running subIds. For tests + diagnostics.
   */
  running(): number;
  /**
   * Total tick count across all subIds since construction. Monotonic.
   * For tests + diagnostics — production wiring should instrument
   * via wrapping `sendHeartbeat` if it wants per-subId counters.
   */
  ticks(): number;
}

function validateInterval(ms: number, label: string): number {
  if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
    throw new RangeError(
      `stream-heartbeat-scheduler: ${label} must be a finite integer, got ${String(ms)}`,
    );
  }
  if (ms < MIN_HEARTBEAT_MS) return MIN_HEARTBEAT_MS;
  if (ms > MAX_HEARTBEAT_MS) return MAX_HEARTBEAT_MS;
  return ms;
}

/**
 * Create a heartbeat scheduler. The daemon process holds one shared
 * instance across all PTY sessions (perf-P1-C — single setInterval is
 * cheaper than one-per-subscriber); tests typically construct a fresh
 * instance per case.
 */
export function createHeartbeatScheduler(
  opts: HeartbeatSchedulerOptions,
): HeartbeatScheduler {
  if (typeof opts.sendHeartbeat !== 'function') {
    throw new TypeError(
      'stream-heartbeat-scheduler: sendHeartbeat callback is required',
    );
  }
  let intervalMs = validateInterval(
    opts.intervalMs ?? DEFAULT_HEARTBEAT_MS,
    'intervalMs',
  );
  const sendHeartbeat = opts.sendHeartbeat;
  // `now` is only used by `ticks()` consumers indirectly; we retain
  // the option for symmetry with stream-dead-detector even though the
  // scheduler does not need wall-clock arithmetic.
  void (opts.now ?? Date.now);

  const hostTimers: TimerHooks = opts.timers ?? {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  // subId -> active timer handle. Map presence === "running".
  const handles = new Map<SubscriberId, unknown>();
  let totalTicks = 0;

  function arm(subId: SubscriberId): unknown {
    return hostTimers.setInterval(() => {
      totalTicks++;
      try {
        sendHeartbeat(subId);
      } catch {
        // Swallow — one bad subscriber must not starve the shared
        // scheduler. Wiring layer is expected to instrument by
        // wrapping `sendHeartbeat` if it wants observability.
      }
    }, intervalMs);
  }

  function start(subId: SubscriberId): void {
    if (handles.has(subId)) return; // idempotent — no phase reset
    handles.set(subId, arm(subId));
  }

  function stop(subId: SubscriberId): void {
    const h = handles.get(subId);
    if (h === undefined) return; // idempotent — no-op on unknown
    hostTimers.clearInterval(h);
    handles.delete(subId);
  }

  function updateInterval(newMs: number): void {
    const next = validateInterval(newMs, 'newMs');
    if (next === intervalMs) return; // no churn on no-op renegotiation
    intervalMs = next;
    // Re-arm every running subId at the new period. Tearing down +
    // re-arming means the next tick lands at `now + newMs`, which is
    // the correct semantic for "applies on next tick" — leaving the
    // old timer to fire one last time would defeat the whole point
    // of a renegotiation that shortens the interval (e.g. supervisor
    // dropping it from 30 s to 5 s during an active diagnostic).
    for (const [subId, h] of handles) {
      hostTimers.clearInterval(h);
      handles.set(subId, arm(subId));
    }
  }

  function running(): number {
    return handles.size;
  }

  function ticks(): number {
    return totalTicks;
  }

  return { start, stop, updateInterval, running, ticks };
}
