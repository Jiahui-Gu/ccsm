// Per-session fan-out registry for PTY data subscribers.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
// §3.5.1.5 — "Single fan-out registry per session ... Each ptySubscribe
// call registers a callback on the session's Set<Subscriber>; PTY data hits
// each callback synchronously in registration order, wrapped in try/catch
// so one slow subscriber cannot poison others."
//
// Single Responsibility (per feedback_single_responsibility): this module
// is the SINK side of the producer/decider/sink trio.
//   - Producer: PTY `onData` event (NOT here — T42-T48 territory).
//   - Decider: T40 snapshot semaphore + T43 drop-slowest watermark
//     (separate modules; this registry must not enforce backpressure).
//   - Sink (this file): hold the per-session subscriber set and route
//     broadcasts to it.
//
// Hard non-goals (do NOT add here, push back if asked):
//   - No serialization / framing — caller passes already-built message.
//   - No backpressure / drop-slowest accounting — owned by T43.
//   - No PTY event listening — owned by T42 producer wiring.
//   - No lifecycle FSM — drainSession is invoked BY the lifecycle
//     module (T37) at exit/crash transitions; this file just executes
//     the bulk-close.

/**
 * A subscriber is identified by an opaque object reference (Set identity).
 * The registry only invokes `deliver` on broadcast and `close` on drain.
 * Callers (T42 producer, T44 stream RPC) own the Subscriber instance and
 * provide it on subscribe; the registry never inspects fields like
 * `lastAck`, `streamId`, `bufferQueue` — those are owned by callers and
 * by T43's drop-slowest decider.
 */
export interface Subscriber<TMessage = unknown> {
  /** Invoked once per broadcast. MUST NOT throw to caller — registry
   *  catches and logs so one slow subscriber cannot poison others
   *  (§3.5.1.5). */
  deliver(message: TMessage): void;
  /** Invoked once when the registry drains the session (e.g. PTY exit,
   *  daemon shutdown). The registry passes the structured reason; the
   *  subscriber is responsible for closing its underlying stream and
   *  releasing resources. MUST NOT throw to caller. */
  close(reason: DrainReason): void;
}

/** Structured close reason for `drainSession`. The registry is reason-
 *  agnostic — callers (T37 lifecycle FSM, shutdown sequence §3.5.1.2)
 *  pick the appropriate enum and optional human-readable detail. */
export interface DrainReason {
  /** Coarse cause. Mirrors §3.5.1.2 / §3.5.1.5 vocabulary.
   *  - `'pty-exit'`: session exited normally; lifecycle FSM transition
   *    to `exited`.
   *  - `'pty-crashed'`: session exited abnormally; lifecycle FSM
   *    transition to `crashed`.
   *  - `'daemon-shutdown'`: daemon-wide shutdown (§3.5.1.2 step 4).
   *  - `'session-removed'`: session row deleted while subscribers still
   *    attached (defensive). */
  kind: 'pty-exit' | 'pty-crashed' | 'daemon-shutdown' | 'session-removed';
  /** Optional free-form detail for log lines. */
  detail?: string;
}

export interface FanoutRegistry<TMessage = unknown> {
  /** Register `subscriber` for `sessionId`. Returns an unsubscribe
   *  function that removes only this subscriber (idempotent — calling
   *  the returned fn twice is a no-op). The same Subscriber object can
   *  be subscribed to multiple sessions; identity is per (sessionId,
   *  subscriber) pair. */
  subscribe(sessionId: string, subscriber: Subscriber<TMessage>): () => void;
  /** Remove `subscriber` from `sessionId`. No-op if not present. Does
   *  NOT invoke `subscriber.close()` — the caller is performing the
   *  removal voluntarily and owns its own cleanup. */
  unsubscribe(sessionId: string, subscriber: Subscriber<TMessage>): void;
  /** Synchronously deliver `message` to every subscriber currently
   *  registered for `sessionId`. Iteration is over a snapshot taken at
   *  call entry, so subscribers added/removed mid-broadcast do not
   *  affect this broadcast (§3.5.1.5: "registration order, wrapped in
   *  try/catch"). No-op if the session has no subscribers. */
  broadcast(sessionId: string, message: TMessage): void;
  /** Return the current set of subscribers for `sessionId` as an
   *  immutable array snapshot. Primarily for tests and for T43's
   *  drop-slowest decider to enumerate candidates. Empty array if the
   *  session has no subscribers. */
  getSubscribers(sessionId: string): ReadonlyArray<Subscriber<TMessage>>;
  /** Bulk-close every subscriber for `sessionId`. Each subscriber's
   *  `close(reason)` is invoked exactly once (errors caught & logged),
   *  the session entry is removed from the registry, and subsequent
   *  broadcasts to that sessionId are no-ops until a new `subscribe`
   *  re-creates the entry. No-op if the session has no subscribers. */
  drainSession(sessionId: string, reason: DrainReason): void;
}

export interface FanoutRegistryOptions {
  /** Optional logger for caught subscriber errors. Defaults to
   *  `console.warn`. The daemon will pass a pino child logger in
   *  wiring (T42); tests can pass a spy. */
  onSubscriberError?: (
    err: unknown,
    ctx: { sessionId: string; phase: 'deliver' | 'close' },
  ) => void;
}

const defaultErrorLogger: NonNullable<FanoutRegistryOptions['onSubscriberError']> = (
  err,
  ctx,
) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[fanout-registry] subscriber threw during ${ctx.phase} for session ${ctx.sessionId}`,
    err,
  );
};

/**
 * Create a new fan-out registry instance. The daemon process holds one
 * instance shared across all PTY sessions; tests typically create a
 * fresh instance per case to avoid cross-test state.
 */
export function createFanoutRegistry<TMessage = unknown>(
  opts: FanoutRegistryOptions = {},
): FanoutRegistry<TMessage> {
  const onError = opts.onSubscriberError ?? defaultErrorLogger;
  // Per-session subscriber set. We use Set for O(1) add/remove and to
  // dedupe accidental double-subscribe of the same Subscriber object.
  // Insertion order is preserved (Set semantics), satisfying the spec's
  // "registration order" requirement (§3.5.1.5).
  const bySession = new Map<string, Set<Subscriber<TMessage>>>();

  function subscribe(
    sessionId: string,
    subscriber: Subscriber<TMessage>,
  ): () => void {
    let set = bySession.get(sessionId);
    if (!set) {
      set = new Set();
      bySession.set(sessionId, set);
    }
    set.add(subscriber);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      unsubscribe(sessionId, subscriber);
    };
  }

  function unsubscribe(
    sessionId: string,
    subscriber: Subscriber<TMessage>,
  ): void {
    const set = bySession.get(sessionId);
    if (!set) return;
    set.delete(subscriber);
    if (set.size === 0) {
      bySession.delete(sessionId);
    }
  }

  function broadcast(sessionId: string, message: TMessage): void {
    const set = bySession.get(sessionId);
    if (!set || set.size === 0) return;
    // Snapshot-then-iterate. A subscriber that calls subscribe() or
    // unsubscribe() inside its deliver() callback must NOT mutate the
    // current broadcast's iteration (§3.5.1.5: a slow subscriber
    // cannot poison others — and a re-entrant one likewise cannot
    // skip/double-deliver to peers). Set iteration in JS is live; the
    // copy is mandatory.
    const snapshot = Array.from(set);
    for (const subscriber of snapshot) {
      try {
        subscriber.deliver(message);
      } catch (err) {
        onError(err, { sessionId, phase: 'deliver' });
      }
    }
  }

  function getSubscribers(
    sessionId: string,
  ): ReadonlyArray<Subscriber<TMessage>> {
    const set = bySession.get(sessionId);
    if (!set || set.size === 0) return [];
    return Array.from(set);
  }

  function drainSession(sessionId: string, reason: DrainReason): void {
    const set = bySession.get(sessionId);
    if (!set || set.size === 0) {
      // Still ensure the entry is gone (defensive — empty Sets are
      // already pruned by unsubscribe(), but a caller might drain a
      // session that never had subscribers, which is fine).
      bySession.delete(sessionId);
      return;
    }
    // Snapshot first, then evict the session entry, THEN invoke close
    // on each subscriber. This ordering means any close() callback
    // that re-enters subscribe(sessionId, ...) creates a fresh entry
    // (the session is "drained" by the time close fires), which
    // matches the lifecycle FSM intent: drain marks the OLD generation
    // closed; new subscribers attach to a fresh registry slot.
    const snapshot = Array.from(set);
    bySession.delete(sessionId);
    for (const subscriber of snapshot) {
      try {
        subscriber.close(reason);
      } catch (err) {
        onError(err, { sessionId, phase: 'close' });
      }
    }
  }

  return {
    subscribe,
    unsubscribe,
    broadcast,
    getSubscribers,
    drainSession,
  };
}
