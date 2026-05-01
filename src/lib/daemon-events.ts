/**
 * Renderer-side daemon event bus.
 *
 * Producers: T69 useDaemonReconnectBridge (preload) translates main-process
 * IPC into 'bootChanged' / 'streamDead' / 'reconnected' / 'unreachable'
 * events. Consumers: T70 reconnect-queue (this file's sibling) and any UI
 * surface that wants to react to daemon connectivity transitions.
 *
 * Pure singleton EventEmitter wrapper — zero socket / IPC awareness, so it
 * can be unit-tested without a daemon. Producers call `emit`; consumers call
 * `on` / `off`.
 *
 * Coordinates with T69 (#1028). If T69 already lands a daemon-events module,
 * the manager picks one in conflict resolution; both sides agree on event
 * names and payload shapes (see types below).
 */

export type ActiveSubId = string;

/**
 * Daemon process restarted (new bootNonce). All subscriptions belong to the
 * old daemon and must be re-established from seq 0 with the new nonce. Emit
 * source: client receives `{ kind: 'bootChanged', bootNonce }` on any open
 * stream (frag-3.5.1 §3.5.1.4) OR supervisor crosses heartbeat threshold
 * (frag-6-7 §6.5).
 */
export interface BootChangedEvent {
  bootNonce: string;
}

/**
 * A single per-subscription stream went silent (heartbeat missed, transport
 * closed, RESOURCE_EXHAUSTED slow-subscriber drop, etc.). The daemon may
 * still be healthy; only this one subId needs a resubscribe + replay from
 * lastSeq.
 */
export interface StreamDeadEvent {
  subId: ActiveSubId;
  /** Last seq the consumer has applied; undefined = subscribe fresh. */
  lastSeq?: number;
  /** Optional reason for logs/UI; not load-bearing. */
  reason?: string;
}

/**
 * Bridge call recovered (used by §6.1.1 toast and to clear unreachable
 * banner). Reconnect-queue does not consume this directly; UI does.
 */
export interface ReconnectedEvent {
  bootNonce: string;
}

/** Bridge gave up after retries (banner red). */
export interface UnreachableEvent {
  reason: string;
}

export interface DaemonEventMap {
  bootChanged: BootChangedEvent;
  streamDead: StreamDeadEvent;
  reconnected: ReconnectedEvent;
  unreachable: UnreachableEvent;
}

export type DaemonEventName = keyof DaemonEventMap;
export type DaemonEventListener<K extends DaemonEventName> = (
  payload: DaemonEventMap[K]
) => void;

/**
 * Tiny typed pub/sub. We deliberately do NOT use Node's EventEmitter — the
 * renderer bundle ships to browsers (jsdom in tests, Electron renderer at
 * runtime) and the polyfill bloat is not worth it for four event types.
 */
export class DaemonEventBus {
  private readonly listeners: {
    [K in DaemonEventName]: Set<DaemonEventListener<K>>;
  } = {
    bootChanged: new Set(),
    streamDead: new Set(),
    reconnected: new Set(),
    unreachable: new Set(),
  };

  on<K extends DaemonEventName>(event: K, fn: DaemonEventListener<K>): () => void {
    this.listeners[event].add(fn);
    return () => this.off(event, fn);
  }

  off<K extends DaemonEventName>(event: K, fn: DaemonEventListener<K>): void {
    this.listeners[event].delete(fn);
  }

  emit<K extends DaemonEventName>(event: K, payload: DaemonEventMap[K]): void {
    // Snapshot so a listener that unsubscribes mid-fanout doesn't skip a sibling.
    const snapshot = Array.from(this.listeners[event]);
    for (const fn of snapshot) {
      try {
        fn(payload);
      } catch (err) {
        // Bus must never throw across listeners. Surface to console for
        // dev visibility; the renderer log forwarder (frag-6-7 §6.6.2)
        // ships these to electron-main when CCSM_RENDERER_LOG_FORWARD=1.
        // eslint-disable-next-line no-console
        console.error('[daemon-events] listener threw', event, err);
      }
    }
  }

  /** Test helper — drop all listeners. Not used in production. */
  removeAll(): void {
    for (const set of Object.values(this.listeners)) set.clear();
  }
}

/** Module-level singleton. Producers and consumers share this instance. */
export const daemonEventBus = new DaemonEventBus();
