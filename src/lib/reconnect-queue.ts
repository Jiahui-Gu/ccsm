/**
 * Reconnect queue (renderer, T70).
 *
 * Listens to the daemon-events bus and serializes reconnect-replay attempts
 * for active stream subscriptions:
 *
 *   - 'bootChanged'  → enqueue a "full re-subscribe" task per active sub
 *                      (lastSeq cleared; daemon will replay from seq 0 with
 *                      new bootNonce, per frag-3.5.1 §3.5.1.4).
 *   - 'streamDead'   → enqueue a single resubscribe + replay seq>lastSeq
 *                      task for that subId (frag-6-7 §6.6.1
 *                      `stream_resubscribe`).
 *
 * Concurrency cap: at most N concurrent reconnect attempts (default 3).
 * Backoff: exponential per task, 200ms → 400ms → 800ms cap 5s. Each task
 * tracks its own attempt counter; success removes it.
 *
 * Pure logic + injected `reconnectFn(subId, lastSeq?)` — no socket I/O here.
 * The actual bridge call lives in the preload reconnect bridge (T69 hook),
 * which constructs a queue with its own reconnectFn at boot.
 */

import {
  daemonEventBus as defaultBus,
  type DaemonEventBus,
  type ActiveSubId,
} from './daemon-events';

/** Result of a single reconnect attempt. */
export type ReconnectOutcome = 'ok' | 'retry' | 'fatal';

/**
 * Caller-supplied bridge call. Resolves 'ok' (or void) on success, 'retry'
 * to schedule another attempt with backoff, 'fatal' to drop the task. Any
 * thrown / rejected value is treated as 'retry'.
 */
export type ReconnectFn = (
  subId: ActiveSubId,
  lastSeq: number | undefined,
) => Promise<ReconnectOutcome | void>;

export interface ActiveSubscription {
  subId: ActiveSubId;
  lastSeq?: number;
}

export interface ReconnectQueueOptions {
  concurrency?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  bus?: DaemonEventBus;
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

interface QueuedTask {
  subId: ActiveSubId;
  lastSeq: number | undefined;
  attempt: number;
  inFlight: boolean;
}

const DEFAULTS = { concurrency: 3, baseDelayMs: 200, maxDelayMs: 5000 };

/**
 * attempt 0 → 0; attempt N → base * 2^(N-1), capped at maxDelayMs.
 * Pulled out as a pure function for unit-test readability.
 */
export function computeBackoff(
  attempt: number,
  baseDelayMs = DEFAULTS.baseDelayMs,
  maxDelayMs = DEFAULTS.maxDelayMs,
): number {
  if (attempt <= 0) return 0;
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

export class ReconnectQueue {
  private readonly concurrency: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly bus: DaemonEventBus;
  private readonly scheduler: NonNullable<ReconnectQueueOptions['scheduler']>;
  private readonly reconnectFn: ReconnectFn;

  private readonly active = new Map<ActiveSubId, ActiveSubscription>();
  private readonly tasks: QueuedTask[] = [];
  private readonly pendingTimers = new Set<unknown>();
  private inFlightCount = 0;
  private disposed = false;
  private readonly unsubs: Array<() => void> = [];

  constructor(reconnectFn: ReconnectFn, opts: ReconnectQueueOptions = {}) {
    this.reconnectFn = reconnectFn;
    this.concurrency = opts.concurrency ?? DEFAULTS.concurrency;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.bus = opts.bus ?? defaultBus;
    this.scheduler = opts.scheduler ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
    };

    this.unsubs.push(this.bus.on('bootChanged', () => this.onBootChanged()));
    this.unsubs.push(
      this.bus.on('streamDead', (e) => this.onStreamDead(e.subId, e.lastSeq)),
    );
  }

  // -- Subscription registry --------------------------------------------

  register(sub: ActiveSubscription): void {
    this.active.set(sub.subId, { ...sub });
  }
  updateLastSeq(subId: ActiveSubId, lastSeq: number): void {
    const sub = this.active.get(subId);
    if (sub) sub.lastSeq = lastSeq;
  }
  unregister(subId: ActiveSubId): void {
    this.active.delete(subId);
  }
  getActiveCount(): number { return this.active.size; }
  getQueueDepth(): number { return this.tasks.length; }
  getInFlightCount(): number { return this.inFlightCount; }

  // -- Event handlers ---------------------------------------------------

  private onBootChanged(): void {
    if (this.disposed) return;
    // Clear lastSeq so daemon replays from 0 under the new bootNonce
    // (frag-3.5.1 §3.5.1.4 bootChanged path).
    for (const sub of this.active.values()) {
      this.enqueue({ subId: sub.subId, lastSeq: undefined });
    }
    this.pump();
  }

  private onStreamDead(subId: ActiveSubId, lastSeqFromEvent?: number): void {
    if (this.disposed) return;
    // Prefer tracked lastSeq (consumer may be ahead of event payload).
    const sub = this.active.get(subId);
    const lastSeq = sub?.lastSeq ?? lastSeqFromEvent;
    this.enqueue({ subId, lastSeq });
    this.pump();
  }

  // -- Queue mechanics --------------------------------------------------

  private enqueue(seed: { subId: ActiveSubId; lastSeq: number | undefined }): void {
    // Coalesce on subId. If a queued (not-yet-fired) task exists, refresh
    // its lastSeq so the most recent intent wins. If an in-flight task
    // exists, leave it alone — it will complete or schedule its own retry.
    // Either way, no duplicate per subId, so bursts can't pile up.
    const existing = this.tasks.find((t) => t.subId === seed.subId);
    if (existing) {
      if (!existing.inFlight) {
        existing.lastSeq = seed.lastSeq;
        existing.attempt = 0;
      }
      return;
    }
    this.tasks.push({ subId: seed.subId, lastSeq: seed.lastSeq, attempt: 0, inFlight: false });
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.inFlightCount < this.concurrency) {
      const task = this.tasks.find((t) => !t.inFlight);
      if (!task) return;
      task.inFlight = true;
      this.inFlightCount++;
      this.runWithDelay(task);
    }
  }

  private runWithDelay(task: QueuedTask): void {
    const delay = computeBackoff(task.attempt, this.baseDelayMs, this.maxDelayMs);
    const fire = () => this.fire(task);
    if (delay <= 0) {
      // Yield a microtask so consumers always see async behavior, even on
      // attempt 0 from inside an event handler.
      Promise.resolve().then(fire);
    } else {
      const handle = this.scheduler.setTimeout(() => {
        this.pendingTimers.delete(handle);
        fire();
      }, delay);
      this.pendingTimers.add(handle);
    }
  }

  private fire(task: QueuedTask): void {
    if (this.disposed) {
      this.finish(task);
      return;
    }
    Promise.resolve()
      .then(() => this.reconnectFn(task.subId, task.lastSeq))
      .then(
        (outcome) => {
          if (outcome === 'fatal' || outcome === 'ok' || outcome === undefined) {
            this.finish(task);
          } else {
            // 'retry': bump attempt, re-arm with backoff. Slot stays held.
            task.attempt++;
            this.runWithDelay(task);
          }
        },
        () => {
          // Thrown / rejected = retry.
          task.attempt++;
          this.runWithDelay(task);
        },
      );
  }

  private finish(task: QueuedTask): void {
    const idx = this.tasks.indexOf(task);
    if (idx >= 0) this.tasks.splice(idx, 1);
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    if (!this.disposed) this.pump();
  }

  // -- Lifecycle --------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const h of this.pendingTimers) this.scheduler.clearTimeout(h);
    this.pendingTimers.clear();
    this.tasks.length = 0;
    this.active.clear();
    this.inFlightCount = 0;
  }
}
