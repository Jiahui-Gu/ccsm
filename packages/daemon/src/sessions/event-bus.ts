// In-memory, principal-scoped pub/sub bus for SessionEvent.
//
// Spec refs:
//   - ch05 §5 — `WatchSessions` filters the in-memory event bus by
//     `principalKey(ctx.principal)`; `WATCH_SCOPE_ALL` is rejected for
//     non-admin principals.
//   - ch05 §6 — Create flow emits `SessionEvent.created` after INSERT.
//
// SRP (dev.md §3): this module is a single SINK — it owns the
// subscriber map and the fanout side effect. It has NO knowledge of DB,
// proto, or transport. Producers call `publish`; consumers call
// `subscribe`. Filtering is done HERE so subscribers cannot
// accidentally see other principals' events even if they pass the wrong
// predicate (security boundary, not perf hint — per task constraints).
//
// Layer 1 — alternatives checked:
//   - `node:events.EventEmitter` would work, but it has no built-in
//     per-subscriber filter and the listener-leak warning fires at 11
//     listeners (the daemon may have N watchers per principal). A
//     20-line bespoke bus is simpler than configuring EventEmitter.
//   - RxJS / mitt / nanoevents: all are extra deps for what is a
//     `Set<Listener>` + `for-of` loop. Not justified.
//   - Connect-ES has no event-bus primitive; the WatchSessions handler
//     will adapt this bus into a `ServerStreamingHandler` (T3.3).

import type { SessionEvent } from './types.js';

/**
 * Event subscriber callback. Called synchronously from `publish` for
 * every event whose `session.owner_id` matches the subscriber's
 * `principalKey`. Listener exceptions are caught and reported via
 * `onListenerError` (default: console.error) so a single buggy
 * subscriber cannot prevent fanout to others or corrupt the publisher.
 */
export type SessionEventListener = (event: SessionEvent) => void;

/**
 * Unsubscribe handle returned by `subscribe`. Calling it removes the
 * listener; calling it twice is a no-op (idempotent — common pattern
 * for React effect cleanup / Connect handler abort).
 */
export type Unsubscribe = () => void;

export interface SessionEventBusOptions {
  /**
   * Override for listener-error reporting. Default delegates to
   * `console.error` with a stable prefix so daemon logs remain greppable.
   * Tests pass a vi.fn() to assert the bus does NOT swallow errors
   * silently (a regression here would mask broken subscribers).
   */
  readonly onListenerError?: (err: unknown, event: SessionEvent) => void;
}

/**
 * Principal-scoped, in-memory pub/sub for `SessionEvent`.
 *
 * Fanout rule (security boundary): a listener subscribed with
 * `principalKey = K` ONLY receives events whose `session.owner_id === K`.
 * The check happens inside `publish`, BEFORE the listener is invoked —
 * a buggy subscription predicate cannot leak cross-principal events.
 *
 * Concurrency: every operation is synchronous. better-sqlite3 is sync;
 * the manager publishes inside the same call stack as the INSERT, so
 * watchers observe the event after the transaction commits but before
 * the RPC returns to the client. This matches the spec ch05 §6 sequence
 * diagram (emit happens between UPDATE state=RUNNING and the response).
 *
 * Listener iteration is over a SNAPSHOT (Array.from) so a listener that
 * unsubscribes itself during dispatch does not skip its peers.
 */
export class SessionEventBus {
  /**
   * Map of principalKey -> set of listeners. Map+Set avoids array
   * `splice(indexOf)` on unsubscribe — O(1) add/remove, listener
   * identity is the key so the same function can subscribe twice (rare,
   * but allowed; both invocations fire on publish).
   */
  private readonly listenersByPrincipal = new Map<string, Set<SessionEventListener>>();
  private readonly onListenerError: (err: unknown, event: SessionEvent) => void;

  constructor(options: SessionEventBusOptions = {}) {
    this.onListenerError =
      options.onListenerError ??
      ((err, event) => {
        // Stable prefix for log-grep; deliberately not a structured-log
        // call here — this bus has no logger dependency. The supervisor
        // log appender (T9.x) can scope-watch on this string.
        console.error(
          '[ccsm-daemon] SessionEventBus listener threw',
          { kind: event.kind, sessionId: event.session.id },
          err,
        );
      });
  }

  /**
   * Subscribe to events for a single principal. Returns an idempotent
   * unsubscribe handle.
   *
   * The subscriber's `principalKey` is the SOLE filter — we do NOT
   * accept arbitrary predicates because the security boundary belongs
   * inside the bus. v0.4 admin-scope subscriptions will be a NEW
   * method (`subscribeAll`), gated by an admin principal kind, rather
   * than a parameter to this one (forces every cross-principal call
   * site to surface to a reviewer).
   */
  subscribe(principalKey: string, listener: SessionEventListener): Unsubscribe {
    if (typeof principalKey !== 'string' || principalKey.length === 0) {
      throw new TypeError('principalKey must be a non-empty string');
    }
    let set = this.listenersByPrincipal.get(principalKey);
    if (set === undefined) {
      set = new Set<SessionEventListener>();
      this.listenersByPrincipal.set(principalKey, set);
    }
    set.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listenersByPrincipal.get(principalKey);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listenersByPrincipal.delete(principalKey);
      }
    };
  }

  /**
   * Publish an event. Synchronously fans out to every listener whose
   * subscription `principalKey` matches `event.session.owner_id`.
   *
   * Listener exceptions are caught — one buggy subscriber cannot break
   * fanout to its peers. The exception is reported through
   * `onListenerError`.
   */
  publish(event: SessionEvent): void {
    const ownerKey = event.session.owner_id;
    const set = this.listenersByPrincipal.get(ownerKey);
    if (set === undefined || set.size === 0) return;
    // Snapshot so a listener that unsubscribes (or subscribes another)
    // during dispatch cannot skip peers.
    const snapshot = Array.from(set);
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
  }

  /**
   * Test/observability helper: number of currently registered listeners
   * for a principal. NOT used for control flow inside the daemon —
   * exposed so unit tests can verify unsubscribe actually removed the
   * entry, and so an admin diag RPC can report subscriber counts in
   * v0.4 without reaching into private state.
   */
  listenerCount(principalKey: string): number {
    return this.listenersByPrincipal.get(principalKey)?.size ?? 0;
  }
}
