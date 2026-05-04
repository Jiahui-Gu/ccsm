// In-memory pub/sub bus for crash-log appends.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md (#228 audit)
//     identifies CrashService.WatchCrashLog as a stub that needs an event
//     source. This module is that source.
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch09
//     (crash capture pipeline). The bus sits AFTER the durable append in
//     `raw-appender.ts:appendCrashRaw` so subscribers only observe entries
//     that survived fsync.
//
// Consumer: future #335 CrashService.WatchCrashLog server-stream handler
// subscribes here; the handler is responsible for any per-principal /
// admin-scope filtering it needs (crashes carry `owner_id` already — the
// 'daemon-self' sentinel + principalKey pattern from ch09 §1).
//
// SRP (dev.md §2): this module is a single SINK — owns the subscriber set
// and the fanout side effect. NO knowledge of NDJSON, fs, proto, or
// transport. The producer hook lives in `raw-appender.ts` where the
// append actually happens (single emit point, not scattered across each
// capture source).
//
// Layer 1 — alternatives checked:
//   - `node:events.EventEmitter` would work but the listener-leak warning
//     fires at 11 listeners and we have no per-subscriber filter to wire
//     in. We mirror `packages/daemon/src/sessions/event-bus.ts` instead so
//     the daemon has ONE event-bus shape across subsystems (operators
//     learn one pattern; reviewers spot deviations).
//   - RxJS / mitt / nanoevents: extra deps for a `Set<Listener>` +
//     `for-of` loop. Not justified.
//   - Principal scoping (sessions/event-bus.ts has it) is intentionally
//     OMITTED here: crashes can be daemon-scoped (`'daemon-self'`) which
//     no principalKey will ever match. The future WatchCrashLog handler
//     applies its own admin-vs-self filter on `entry.owner_id` after
//     subscribing — that policy belongs in the handler, not the bus.

import type { CrashRawEntry } from './raw-appender.js';

/**
 * Listener callback. Called synchronously from `emitCrashAdded` for
 * every appended crash entry. Listener exceptions are caught and
 * reported via `onListenerError` (default: console.error) so a single
 * buggy subscriber cannot prevent fanout to its peers.
 */
export type CrashEventListener = (entry: CrashRawEntry) => void;

/**
 * Unsubscribe handle returned by `onCrashAdded`. Calling it removes the
 * listener; calling it twice is a no-op (idempotent — common pattern
 * for Connect handler abort / React effect cleanup).
 */
export type Unsubscribe = () => void;

export interface CrashEventBusOptions {
  /**
   * Override for listener-error reporting. Default delegates to
   * `console.error` with a stable prefix so daemon logs remain
   * greppable. Tests pass a `vi.fn()` to assert the bus does NOT
   * swallow errors silently.
   */
  readonly onListenerError?: (err: unknown, entry: CrashRawEntry) => void;
}

/**
 * In-memory pub/sub for `CrashRawEntry`.
 *
 * Concurrency: synchronous fanout. The producer (raw-appender) calls
 * `emitCrashAdded` AFTER `fsync` succeeds, so a subscriber observing
 * the event implies the entry is durable on disk.
 *
 * Listener iteration is over a SNAPSHOT (Array.from) so a listener
 * that unsubscribes itself during dispatch does not skip its peers.
 */
export class CrashEventBus {
  /**
   * Set of listeners. We use `Set` for O(1) add/remove and to allow the
   * same function to subscribe twice (rare, but allowed; both
   * invocations fire on emit, mirroring sessions/event-bus.ts).
   */
  private readonly listeners = new Set<CrashEventListener>();
  private readonly onListenerError: (err: unknown, entry: CrashRawEntry) => void;

  constructor(options: CrashEventBusOptions = {}) {
    this.onListenerError =
      options.onListenerError ??
      ((err, entry) => {
        // Stable prefix for log-grep; deliberately not a structured-log
        // call here — the bus has no logger dependency.
        console.error(
          '[ccsm-daemon] CrashEventBus listener threw',
          { id: entry.id, source: entry.source },
          err,
        );
      });
  }

  /**
   * Subscribe to crash-added events. Returns an idempotent unsubscribe
   * handle.
   *
   * The bus does NOT filter by `owner_id` — the consumer (#335
   * WatchCrashLog handler) applies any principal / admin-scope policy
   * it needs. Crashes can be daemon-scoped (`'daemon-self'`) and the
   * spec wants admin operators to see those even when no session
   * principal matches.
   */
  onCrashAdded(listener: CrashEventListener): Unsubscribe {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /**
   * Emit a crash-added event. Synchronously fans out to every listener.
   *
   * Listener exceptions are caught — one buggy subscriber cannot break
   * fanout to its peers. The exception is reported through
   * `onListenerError`.
   */
  emitCrashAdded(entry: CrashRawEntry): void {
    if (this.listeners.size === 0) return;
    // Snapshot so a listener that unsubscribes (or subscribes another)
    // during dispatch cannot skip peers.
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(entry);
      } catch (err) {
        this.onListenerError(err, entry);
      }
    }
  }

  /**
   * Test/observability helper: number of currently registered
   * listeners. NOT used for control flow — exposed so unit tests can
   * verify unsubscribe actually removed the entry.
   */
  listenerCount(): number {
    return this.listeners.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level default singleton.
//
// The append path in `raw-appender.ts:appendCrashRaw` emits on this
// singleton so wire-up is "free" — capture sources keep calling
// `appendCrashRaw` exactly as before, and any future #335 handler can
// `import { defaultCrashEventBus } from '.../crash/event-bus.js'` and
// `onCrashAdded(...)` to subscribe.
//
// Tests that need isolation construct their own `new CrashEventBus()`
// (the spec file does this for every case).
// ---------------------------------------------------------------------------

/**
 * Process-wide default bus used by the durable append path. Exported as
 * `let` so test setups can reset it if they ever need to (none do
 * today, but the affordance is cheap).
 */
export const defaultCrashEventBus = new CrashEventBus();
