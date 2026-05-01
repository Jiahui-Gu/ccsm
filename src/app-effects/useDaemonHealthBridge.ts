// Task #1060 — `useDaemonHealthBridge`: consolidated React hook that
// surfaces the renderer-side daemon connectivity snapshot. v0.3 work
// shipped multiple per-fragment bridges (`useDaemonReconnectBridge`
// #1028 PRODUCER + `daemonEventBus` typed pub/sub + `reconnectQueue`
// SINK). Each downstream consumer would otherwise have to subscribe to
// the bus on its own and reassemble the same fields. This hook owns the
// reassembly so call sites read a single snapshot.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-design.md §6.8 — renderer-side
//     consolidated `daemonHealth` surface (originally listed as a
//     spec-only symbol; tests under `tests/harness-daemon-mode.test.ts`
//     §1201-1205 explicitly note this hook had not yet been built).
//   - docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//     §3.5.1.4 — `bootNonce` carries through every daemon-emitted
//     envelope; a change means the daemon was restarted and replay
//     state is invalid.
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.5–§6.6 — server-side stream-dead detector + reconnected /
//     unreachable bridge transitions feed the same bus.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   DECIDER. Subscribes ONCE to the typed `daemonEventBus`, folds the
//   four event streams into a single immutable snapshot, exposes that
//   snapshot to React via `useSyncExternalStore`. Owns no I/O, no event
//   emission, no reconnect mechanics. PRODUCER side stays in
//   `useDaemonReconnectBridge` / preload bridges; SINK side stays in
//   `reconnect-queue.ts`.
//
// Back-compat note: existing fragments (`useDaemonReconnectBridge` and
// the `daemonEventBus` itself) are intentionally NOT removed in this PR.
// `useDaemonReconnectBridge` solves a different problem (window
// `CustomEvent` re-emission from a `subscribe(cb)` source for callers
// that don't want to hold a bus reference) and currently has no in-tree
// consumer to migrate. New read-side call sites should use this hook.

import { useSyncExternalStore } from 'react';
import {
  daemonEventBus as defaultBus,
  type DaemonEventBus,
} from '../lib/daemon-events';

/**
 * High-level daemon connectivity status as observed from the renderer.
 *
 * - `unknown`  — no event has arrived yet (hook just mounted, daemon
 *                hasn't sent its first envelope).
 * - `healthy`  — last transition was `bootChanged` or `reconnected` and
 *                no `streamDead` / `unreachable` has fired since.
 * - `degraded` — at least one stream-dead has fired since last healthy
 *                transition; daemon may still be reachable, individual
 *                subscriptions are recovering (frag-6-7 §6.6.1).
 * - `unreachable` — bridge gave up after retries (frag-6-7 §6.5 banner
 *                   red state). Cleared by next `reconnected` /
 *                   `bootChanged`.
 */
export type DaemonHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'unreachable';

/**
 * Immutable snapshot returned by the hook. Identity is stable across
 * renders when underlying state has not changed (required by
 * `useSyncExternalStore` to avoid render loops).
 */
export interface DaemonHealthSnapshot {
  /** Aggregated status. See `DaemonHealthStatus` doc above. */
  readonly status: DaemonHealthStatus;
  /** ms-epoch of the most recently observed event of any kind, or
   *  `null` if no event has arrived yet. */
  readonly lastSeen: number | null;
  /** Cumulative count of `streamDead` events since the hook started.
   *  Mirrors what individual consumers used to count themselves. The
   *  reconnect queue still owns per-subId attempt counters; this is a
   *  process-wide tally for surfaces (banners, dev panels). */
  readonly reconnectAttempt: number;
  /** Most recently observed daemon `bootNonce`, or `null`. Useful for
   *  surfaces that want to display the daemon identity. */
  readonly version: string | null;
  /** Reason from the last `unreachable` event, or `null` if currently
   *  reachable / never unreachable. */
  readonly lastUnreachableReason: string | null;
  /** subId of the last stream-dead event, or `null`. Surfaces that
   *  show "session X reconnecting…" can read this directly. */
  readonly lastStreamDeadSubId: string | null;
}

interface MutableState {
  status: DaemonHealthStatus;
  lastSeen: number | null;
  reconnectAttempt: number;
  version: string | null;
  lastUnreachableReason: string | null;
  lastStreamDeadSubId: string | null;
}

const INITIAL_SNAPSHOT: DaemonHealthSnapshot = Object.freeze({
  status: 'unknown',
  lastSeen: null,
  reconnectAttempt: 0,
  version: null,
  lastUnreachableReason: null,
  lastStreamDeadSubId: null,
});

/**
 * Module-level store. Single subscription to the bus is created lazily
 * the first time a hook instance mounts and torn down when the last one
 * unmounts. Multiple consumers across the tree share the same snapshot
 * (the whole point of consolidation) — they all see consistent reads.
 *
 * Exposed as a class so a test can construct an isolated instance with
 * its own bus (see `__createDaemonHealthStoreForTest`). Production code
 * uses the module-level `defaultDaemonHealthStore`.
 */
export class DaemonHealthStore {
  private state: MutableState;
  private snapshot: DaemonHealthSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly bus: DaemonEventBus;
  private readonly clock: () => number;
  private busUnsubs: Array<() => void> = [];
  private subscriberCount = 0;

  constructor(
    bus: DaemonEventBus = defaultBus,
    clock: () => number = () => Date.now(),
  ) {
    this.bus = bus;
    this.clock = clock;
    this.state = {
      status: 'unknown',
      lastSeen: null,
      reconnectAttempt: 0,
      version: null,
      lastUnreachableReason: null,
      lastStreamDeadSubId: null,
    };
  }

  getSnapshot = (): DaemonHealthSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.subscriberCount === 0) this.attachBus();
    this.subscriberCount++;
    return () => {
      this.listeners.delete(listener);
      this.subscriberCount = Math.max(0, this.subscriberCount - 1);
      if (this.subscriberCount === 0) this.detachBus();
    };
  };

  /** Test helper — number of currently-attached bus listeners. The
   *  whole point of consolidation: this should be 0 (idle) or 4 (one
   *  per event), never N×consumers. */
  getBusSubscriptionCount(): number {
    return this.busUnsubs.length;
  }

  private attachBus(): void {
    // SINGLE subscription path per event. Even with 50 components
    // calling the hook, the bus sees exactly four `on()` calls total.
    this.busUnsubs = [
      this.bus.on('bootChanged', (e) => {
        this.update((s) => {
          s.version = e.bootNonce;
          s.status = 'healthy';
          s.lastUnreachableReason = null;
          s.lastSeen = this.clock();
        });
      }),
      this.bus.on('streamDead', (e) => {
        this.update((s) => {
          s.reconnectAttempt += 1;
          s.lastStreamDeadSubId = e.subId;
          // Don't downgrade from `unreachable` — that's a stronger
          // signal until explicitly cleared by reconnected/bootChanged.
          if (s.status !== 'unreachable') s.status = 'degraded';
          s.lastSeen = this.clock();
        });
      }),
      this.bus.on('reconnected', (e) => {
        this.update((s) => {
          s.version = e.bootNonce;
          s.status = 'healthy';
          s.lastUnreachableReason = null;
          s.lastSeen = this.clock();
        });
      }),
      this.bus.on('unreachable', (e) => {
        this.update((s) => {
          s.status = 'unreachable';
          s.lastUnreachableReason = e.reason;
          s.lastSeen = this.clock();
        });
      }),
    ];
  }

  private detachBus(): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
  }

  private update(mutate: (s: MutableState) => void): void {
    mutate(this.state);
    this.snapshot = Object.freeze({
      status: this.state.status,
      lastSeen: this.state.lastSeen,
      reconnectAttempt: this.state.reconnectAttempt,
      version: this.state.version,
      lastUnreachableReason: this.state.lastUnreachableReason,
      lastStreamDeadSubId: this.state.lastStreamDeadSubId,
    });
    for (const l of Array.from(this.listeners)) {
      try {
        l();
      } catch (err) {
        // Mirrors `daemonEventBus.emit` defensiveness — never throw
        // across React subscribers.
        // eslint-disable-next-line no-console
        console.error('[useDaemonHealthBridge] listener threw', err);
      }
    }
  }
}

/** Production singleton, wired to the shared `daemonEventBus`. */
export const defaultDaemonHealthStore = new DaemonHealthStore();

/**
 * React hook returning a stable, consolidated daemon-health snapshot.
 *
 * Usage:
 *   const health = useDaemonHealthBridge();
 *   if (health.status === 'unreachable') return <RedBanner ... />;
 *
 * Subscription model: regardless of how many components call this
 * hook, the underlying `daemonEventBus` sees exactly one listener per
 * event (four total). Lazy attach on first mount, detach when the last
 * consumer unmounts — verified by `getBusSubscriptionCount()` in tests.
 */
export function useDaemonHealthBridge(
  store: DaemonHealthStore = defaultDaemonHealthStore,
): DaemonHealthSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Test-only factory. Returns an isolated store wired to a caller-
 * supplied bus + clock so unit tests can drive deterministic event
 * sequences without touching the module-level singleton.
 */
export function __createDaemonHealthStoreForTest(
  bus: DaemonEventBus,
  clock: () => number = () => Date.now(),
): DaemonHealthStore {
  return new DaemonHealthStore(bus, clock);
}
