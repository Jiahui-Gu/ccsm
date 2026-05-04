// In-memory pub/sub bus for notify-decider events.
//
// Spec refs:
//   - ch04 §6.1 — `NotifyService.WatchNotifyEvents` server-streams
//     decider-emitted events. Per-principal filter is implicit (peer-cred
//     middleware scopes to ctx.principal's sessions) at the handler layer,
//     so this bus itself is principal-agnostic — the security boundary is
//     the handler's WatchSessions-shaped session-id-to-owner check, not
//     the bus.
//   - Audit #228 (`docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md`
//     sub-task 8) — `notifyDecider` had no event-bus around it, so a
//     future `WatchNotifyEvents` handler had no stream source. This module
//     closes that gap.
//
// SRP (dev.md §3): this module is a single SINK — it owns the subscriber
// set and the synchronous fanout side effect. It has NO knowledge of
// proto, transport, decider rules, or principal scoping. Producers call
// `emitNotifyEvent`; consumers call `onNotifyEvent`.
//
// Layer 1 — alternatives checked:
//   - `node:events.EventEmitter` would work, but its 11-listener leak
//     warning fires below daemon expectations (one watcher per renderer
//     reconnect cycle). A 30-line bespoke bus is simpler than tuning
//     EventEmitter, and matches the existing `sessions/event-bus.ts`
//     pattern (PR #933) so reviewers don't need to context-switch.
//   - RxJS / mitt / nanoevents: extra deps for what is a `Set<Listener>`
//     + `for-of` loop. Not justified.
//   - Re-using `SessionEventBus` directly: it indexes by `principalKey`
//     and demands a `SessionEvent` shape. The notify path doesn't have a
//     principal at the emit site (the decider's caller is
//     `runStateTracker`, which is principal-agnostic) and doesn't carry a
//     `SessionRow`. Same pattern, different payload — copy + tailor.

/**
 * In-process notify event payload. Carries the decider's verdict plus the
 * timestamp the producer fired at, so the future Connect handler can map
 * to the proto `NotifyEvent` (`ts_unix_ms`, `session_id`, `kind`,
 * `flash_pattern`, etc.) without re-querying the decider.
 *
 * `toast` and `flash` mirror the decider's `Decision` shape (see
 * `notifyDecider.ts`). The handler maps each true flag to a separate
 * proto `NotifyEvent` of `NOTIFY_KIND_TOAST` / `NOTIFY_KIND_FLASH` —
 * keeping both flags on the in-memory event lets the handler emit them
 * atomically (one decider firing → 1 or 2 proto events) without a
 * second decider call.
 */
export interface NotifyEvent {
  readonly sid: string;
  readonly toast: boolean;
  readonly flash: boolean;
  /** Unix-ms timestamp the producer fired at. Stable across reconnects. */
  readonly ts: number;
}

/**
 * Listener invoked synchronously from `emitNotifyEvent` for every
 * registered subscriber. Listener exceptions are caught and reported via
 * `onListenerError` (default: `console.error`) so a single buggy
 * subscriber cannot break fanout to its peers.
 */
export type NotifyEventListener = (event: NotifyEvent) => void;

/**
 * Unsubscribe handle returned by `onNotifyEvent`. Idempotent — calling
 * twice is a no-op (matches the React effect / Connect handler abort
 * cleanup pattern; see `sessions/event-bus.ts`).
 */
export type Unsubscribe = () => void;

export interface NotifyEventBusOptions {
  /**
   * Override for listener-error reporting. Default delegates to
   * `console.error` with a stable prefix so daemon logs remain greppable.
   * Tests pass a vi.fn() to assert the bus does NOT swallow errors
   * silently — a regression here would mask broken subscribers.
   */
  readonly onListenerError?: (err: unknown, event: NotifyEvent) => void;
}

/**
 * In-memory pub/sub for notify-decider events.
 *
 * Concurrency: every operation is synchronous. The decider runs inside
 * the same call stack as the OSC-title producer, so subscribers observe
 * the event before control returns to the producer. This matches the
 * `SessionEventBus` semantics used by `WatchSessions`.
 *
 * Listener iteration is over a SNAPSHOT (`Array.from`) so a listener
 * that unsubscribes itself during dispatch does not skip its peers.
 *
 * Principal scoping: this bus does NOT filter by principal. The future
 * `WatchNotifyEvents` handler is responsible for mapping `event.sid` to
 * the session's `owner_id` (via `SessionManager.get`) and dropping
 * cross-principal events before they reach the wire. Mirrors the
 * `WatchSessions` scoping per spec ch04 §6.1.
 */
export class NotifyEventBus {
  /**
   * Set instead of array — O(1) add/remove, listener identity is the
   * key so the same function can subscribe twice (rare, allowed; both
   * invocations fire on emit, matching `SessionEventBus`).
   */
  private readonly listeners = new Set<NotifyEventListener>();
  private readonly onListenerError: (err: unknown, event: NotifyEvent) => void;

  constructor(options: NotifyEventBusOptions = {}) {
    this.onListenerError =
      options.onListenerError ??
      ((err, event) => {
        // Stable prefix for log-grep; deliberately not a structured-log
        // call here — this bus has no logger dependency.
        console.error(
          '[ccsm-daemon] NotifyEventBus listener threw',
          { sid: event.sid, toast: event.toast, flash: event.flash },
          err,
        );
      });
  }

  /**
   * Subscribe to all notify events. Returns an idempotent unsubscribe
   * handle.
   *
   * No principal / sid filter argument — the handler layer applies its
   * own filter (see class comment). v0.4 admin-scope subscriptions land
   * as a NEW method (`onAllNotifyEvents`) gated by an admin principal
   * kind, not as a parameter to this one.
   */
  onNotifyEvent(listener: NotifyEventListener): Unsubscribe {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /**
   * Emit an event. Synchronously fans out to every subscriber.
   *
   * Listener exceptions are caught — one buggy subscriber cannot break
   * fanout to its peers. The exception is reported through
   * `onListenerError`.
   */
  emitNotifyEvent(event: NotifyEvent): void {
    if (this.listeners.size === 0) return;
    // Snapshot so a listener that unsubscribes (or subscribes another)
    // during dispatch cannot skip peers.
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
  }

  /**
   * Test/observability helper: number of currently registered listeners.
   * NOT used for control flow inside the daemon — exposed so unit tests
   * can verify unsubscribe actually removed the entry, and so an admin
   * diag RPC can report subscriber counts in v0.4 without reaching into
   * private state.
   */
  listenerCount(): number {
    return this.listeners.size;
  }
}
