// Per-subscriber ack-state + bounded channel primitive for PtyService.Attach.
//
// Spec ref: docs/superpowers/specs/2026-05-04-pty-attach-handler.md §4.2
// (per-subscriber AckSubscriberState shape) and §4.5 (channel capacity ==
// DELTA_RETENTION_SEQS == 4096; pinning the two equal makes the
// "kick + reconnect on overflow" recovery reliable).
//
// Task #352 — Wave 3 §6.9 sub-task 10 / T-PA-3 (forward-safe).
//
// Scope (one PR = one concern):
//   - The bounded channel primitive (FIFO ring with `enqueue` / `dequeue` /
//     `size` accessors and an explicit overflow signal), and
//   - The `AckSubscriberState` data structure plus pure transitions
//     (`onDelivered`, `onAck`, `unackedBacklog`).
//
// NOT in this PR (T-PA-5 / T-PA-6 / T-PA-8):
//   - The Attach handler itself (subscribes to the emitter, drains the
//     channel into the wire, observes HandlerContext.signal).
//   - The PtySessionEmitter that produces deltas/snapshots into the channel.
//   - The AckPty RPC handler that mutates `lastAckedSeq` from the wire.
//
// SRP (dev.md §2): this module is a (b) decider + the data shape. Pure
// functions over plain records; no I/O, no proto, no Connect imports.
// The Attach handler (sink) and emitter (producer) compose this.
//
// 5-tier "no wheel reinvention" judgement (dev.md §1 step 2):
//   1. Repo has no existing BoundedChannel / RingBuffer export (verified
//      via grep across packages/**).
//   2. `node:stream` Readable.from has bounded backpressure but no peek
//      / size accessor — the §4.3 producer-side check needs `size`
//      synchronously to decide enqueue-vs-close, so Stream is unsuitable.
//      (Spec §9.1 T-PA-3 already locked this judgement.)
//   3. No current daemon dep provides a peekable bounded channel.
//   4. Open-source ring buffers exist but a textbook FIFO ring sized at
//      construction is ~30 lines; copying an OSS impl would add a
//      license-attribution surface for less code than the attribution
//      banner. The `lastDeliveredSeq` / `lastAckedSeq` validation logic
//      around it has no OSS analogue.
//   5. Self-written, justified above. Test coverage in
//      `__tests__/ack-state.spec.ts` exercises every branch (enqueue
//      under cap / overflow signal / dequeue order / size accounting /
//      ack monotonicity / out-of-bounds ack rejection / backlog math).

/**
 * Channel capacity — pinned equal to `DELTA_RETENTION_SEQS` per spec
 * §4.5. Changing one without the other breaks the steady-state
 * "kick + reconnect" recovery invariant: a subscriber that overflows
 * its channel must always be able to reconnect with
 * `since_seq = lastAckedSeq` and resume via deltas-only, which is only
 * true when the in-memory ring has retained everything the channel
 * could have held.
 *
 * Exported as a constant (not configurable per-instance) precisely so
 * a cross-module mismatch is a compile-time / link-time concern.
 */
export const ACK_CHANNEL_CAPACITY = 4096 as const;

/**
 * Result of attempting to enqueue into a {@link BoundedChannel}. The
 * channel never silently drops: callers MUST distinguish `'ok'` from
 * `'overflow'` and react per spec §4.3 (close stream with
 * `Code.ResourceExhausted`, `pty.subscriber_channel_full`).
 */
export type EnqueueResult = 'ok' | 'overflow';

/**
 * FIFO bounded channel with synchronous size accounting. Used by the
 * Attach handler (sink side) to buffer deltas between the emitter
 * listener (producer; runs synchronously inside the IPC `'message'`
 * handler) and the `for-await` loop that yields `PtyFrame`s onto the
 * Connect stream.
 *
 * Implementation: fixed-capacity circular buffer over a plain array,
 * O(1) enqueue / dequeue / size. No allocation per operation after
 * construction (the underlying array is sized once at capacity and
 * holes are filled with `undefined` after dequeue so V8 hidden classes
 * stay stable).
 *
 * Not exported as an event-emitter: callers compose this with their own
 * "wake the consumer" primitive (a `Promise` resolver pair in T-PA-6).
 * Keeping the channel pure data lets the unit tests stay synchronous.
 */
export class BoundedChannel<T> {
  readonly capacity: number;
  // Circular buffer storage. `undefined` slots are vacant (we do not
  // store undefined values; the type parameter is non-nullable in
  // practice — `DeltaInMem` is always defined).
  readonly #buf: Array<T | undefined>;
  #head = 0; // index of the next dequeue
  #tail = 0; // index of the next enqueue
  #size = 0;

  constructor(capacity: number = ACK_CHANNEL_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `BoundedChannel capacity must be a positive integer, got ${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    this.#buf = new Array<T | undefined>(capacity).fill(undefined);
  }

  /** Number of items currently buffered. O(1). */
  get size(): number {
    return this.#size;
  }

  /** True iff `size === 0`. */
  get isEmpty(): boolean {
    return this.#size === 0;
  }

  /** True iff `size === capacity`. */
  get isFull(): boolean {
    return this.#size === this.capacity;
  }

  /**
   * Push an item to the tail of the FIFO. Returns `'overflow'` (and
   * does NOT mutate the channel) when `size === capacity`. Returns
   * `'ok'` after a successful append.
   *
   * Per spec §4.3 the producer-side overflow check happens BEFORE
   * enqueue: callers should treat `'overflow'` as a signal to close
   * the subscriber stream with `Code.ResourceExhausted`, not as a
   * silent retry condition.
   */
  enqueue(item: T): EnqueueResult {
    if (this.#size === this.capacity) {
      return 'overflow';
    }
    this.#buf[this.#tail] = item;
    this.#tail = (this.#tail + 1) % this.capacity;
    this.#size += 1;
    return 'ok';
  }

  /**
   * Remove and return the item at the head of the FIFO, or `undefined`
   * if the channel is empty. The vacated slot is reset to `undefined`
   * so we don't pin GC of the dequeued reference.
   */
  dequeue(): T | undefined {
    if (this.#size === 0) {
      return undefined;
    }
    const item = this.#buf[this.#head];
    this.#buf[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.capacity;
    this.#size -= 1;
    return item;
  }

  /**
   * Peek at the head without removing it. Returns `undefined` if empty.
   * Used by the Attach handler to inspect what would yield next without
   * committing to dequeue (e.g. for seq-gap diagnostics).
   */
  peek(): T | undefined {
    return this.#size === 0 ? undefined : this.#buf[this.#head];
  }

  /**
   * Drop the oldest item if the channel is full, then enqueue. Returns
   * the dropped item (or `undefined` if the channel had room).
   *
   * NOT used by the Attach handler in spec §4 — the spec explicitly
   * chooses "close stream on overflow" over "drop old". This method
   * exists for the per-session in-memory ring of the EMITTER (T-PA-5),
   * which prunes by snapshot cadence but uses the same primitive shape
   * for "old data is fine to lose because the subscriber will rehydrate
   * via snapshot". Keeping it on the same class avoids a parallel
   * implementation drift.
   */
  enqueueDroppingOldest(item: T): T | undefined {
    let dropped: T | undefined;
    if (this.#size === this.capacity) {
      dropped = this.#buf[this.#head];
      this.#buf[this.#head] = undefined;
      this.#head = (this.#head + 1) % this.capacity;
      this.#size -= 1;
    }
    this.#buf[this.#tail] = item;
    this.#tail = (this.#tail + 1) % this.capacity;
    this.#size += 1;
    return dropped;
  }

  /**
   * Empty the channel. Called by the Attach handler on stream teardown
   * so the subscriber's references are released promptly without
   * waiting for the GC to find the channel object.
   */
  clear(): void {
    if (this.#size === 0) {
      this.#head = 0;
      this.#tail = 0;
      return;
    }
    // Walk only the live slots so we don't pin garbage in any vacant
    // ones (which are already `undefined`).
    let i = this.#head;
    for (let n = 0; n < this.#size; n += 1) {
      this.#buf[i] = undefined;
      i = (i + 1) % this.capacity;
    }
    this.#head = 0;
    this.#tail = 0;
    this.#size = 0;
  }
}

/**
 * Result of an `AckSubscriberState.onAck` call. Mirrors the §6.1 ack
 * validation table: out-of-bound (acks a frame the daemon hasn't
 * delivered) and regress (acks a seq lower than the last) are both
 * `Code.InvalidArgument` at the RPC boundary, with distinct
 * `ErrorDetail.code` strings the renderer can instrument.
 */
export type AckResult =
  | { readonly kind: 'ok'; readonly newLastAckedSeq: bigint }
  | {
      readonly kind: 'rejected';
      readonly reason: 'pty.ack_overrun' | 'pty.ack_regress';
      readonly appliedSeq: bigint;
      readonly lastDeliveredSeq: bigint;
      readonly lastAckedSeq: bigint;
    };

/**
 * Per-subscriber ack-state. One instance per Attach RPC stream that
 * was opened with `requires_ack=true`. The Attach handler owns
 * lifecycle (creates on stream open, drops on stream close); the
 * AckPty RPC handler mutates `lastAckedSeq` via {@link onAck}; the
 * Attach handler's emitter listener mutates `lastDeliveredSeq` via
 * {@link onDelivered}.
 *
 * `requires_ack=false` subscribers DO NOT use this struct — they go
 * through the simpler 1024-deep fallback path described in spec §4.4.
 */
export interface AckSubscriberStateInit {
  /** ULID minted by the Attach handler at stream-open time. */
  readonly subscriberId: string;
  /** The session this subscriber attached to. */
  readonly sessionId: string;
  /**
   * The seq the client claims to have already applied (== Attach's
   * `since_seq` after the resume decision succeeds). Initialized to
   * this so `unackedBacklog` reads zero before any frame ships.
   */
  readonly initialSeq: bigint;
  /** Channel capacity override; defaults to {@link ACK_CHANNEL_CAPACITY}. */
  readonly channelCapacity?: number;
}

export class AckSubscriberState {
  readonly subscriberId: string;
  readonly sessionId: string;
  readonly channel: BoundedChannel<DeltaEnvelope>;
  #lastDeliveredSeq: bigint;
  #lastAckedSeq: bigint;

  constructor(init: AckSubscriberStateInit) {
    this.subscriberId = init.subscriberId;
    this.sessionId = init.sessionId;
    this.#lastDeliveredSeq = init.initialSeq;
    this.#lastAckedSeq = init.initialSeq;
    this.channel = new BoundedChannel<DeltaEnvelope>(
      init.channelCapacity ?? ACK_CHANNEL_CAPACITY,
    );
  }

  get lastDeliveredSeq(): bigint {
    return this.#lastDeliveredSeq;
  }

  get lastAckedSeq(): bigint {
    return this.#lastAckedSeq;
  }

  /**
   * `unackedBacklog = lastDeliveredSeq - lastAckedSeq`. The §4.3
   * watchdog uses this; the producer-side overflow check uses
   * `channel.size` directly because acks are decoupled from channel
   * draining (the consumer can dequeue ahead of the client's ack).
   */
  get unackedBacklog(): bigint {
    return this.#lastDeliveredSeq - this.#lastAckedSeq;
  }

  /**
   * Record that a delta has been yielded onto the wire. Called by the
   * Attach handler's `for-await` loop after the channel hands an item
   * to the Connect stream.
   *
   * Validates strict monotonicity against `lastDeliveredSeq` so a
   * programming error in the handler (e.g. delivering an out-of-order
   * delta) trips this layer rather than silently corrupting the ack
   * watermark. Throws on violation — the Attach handler must convert
   * to a Connect error at its boundary.
   */
  onDelivered(seq: bigint): void {
    if (seq <= this.#lastDeliveredSeq) {
      throw new Error(
        `AckSubscriberState.onDelivered: non-monotonic seq ${seq} <= lastDeliveredSeq ${this.#lastDeliveredSeq} (subscriberId=${this.subscriberId})`,
      );
    }
    this.#lastDeliveredSeq = seq;
  }

  /**
   * Record an `AckPty(applied_seq)` from the wire. Returns a
   * structured `AckResult` rather than throwing, because the AckPty
   * RPC handler converts both `'rejected'` cases into
   * `Code.InvalidArgument` Connect responses — exceptions would
   * conflate them with internal errors.
   *
   * Spec §6.1:
   *   - `applied_seq > lastDeliveredSeq` ⇒ overrun (client claims to
   *     have applied a frame the daemon never sent).
   *   - `applied_seq < lastAckedSeq` ⇒ regress.
   *   - `applied_seq == lastAckedSeq` is benign (idempotent ack;
   *     happens when the client retries an AckPty under packet loss).
   */
  onAck(appliedSeq: bigint): AckResult {
    if (appliedSeq > this.#lastDeliveredSeq) {
      return {
        kind: 'rejected',
        reason: 'pty.ack_overrun',
        appliedSeq,
        lastDeliveredSeq: this.#lastDeliveredSeq,
        lastAckedSeq: this.#lastAckedSeq,
      };
    }
    if (appliedSeq < this.#lastAckedSeq) {
      return {
        kind: 'rejected',
        reason: 'pty.ack_regress',
        appliedSeq,
        lastDeliveredSeq: this.#lastDeliveredSeq,
        lastAckedSeq: this.#lastAckedSeq,
      };
    }
    this.#lastAckedSeq = appliedSeq;
    return { kind: 'ok', newLastAckedSeq: appliedSeq };
  }
}

/**
 * Minimal in-memory delta shape that the Attach handler buffers in the
 * subscriber channel. Mirrors `DeltaMessage` (T-PA-1) without the IPC
 * `kind` discriminant (channel members are all deltas; the snapshot
 * frame is sent once at attach-time, outside the channel).
 *
 * Defined here (instead of imported from `types.ts`) because T-PA-1
 * has not landed yet and this PR is forward-safe; once T-PA-1 lands
 * the shapes are byte-identical and this alias becomes a re-export.
 */
export interface DeltaEnvelope {
  readonly seq: bigint;
  readonly tsUnixMs: bigint;
  readonly payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// Per-(principalKey, sessionId) subscriber registry — Task #49 / T4.13.
// ---------------------------------------------------------------------------
//
// The Attach handler (`requires_ack=true` path) instantiates an
// {@link AckSubscriberState} per server-streaming RPC, registers it under
// the calling principal + session, and unregisters in `finally`. The
// AckPty companion handler (spec §6.1) looks the subscriber up by the
// SAME (principalKey, sessionId) tuple — `principalKey` because v0.4
// multi-principal needs subscriber isolation; `sessionId` because every
// AckPty RPC carries `session_id`.
//
// Multi-Attach overlap: spec §6.1 says "the AckPty handler looks it up
// by (principalKey, session_id) returning the FIRST matching subscriber
// whose channel has been awaiting an ack". Implementation-wise: each
// (principalKey, sessionId) maps to an INSERTION-ORDERED set; FIRST
// here means "earliest still-attached subscriber". Reattach overlap is
// rare and the wrong-stream ack is benign per spec ("the right
// subscriber will hit a stalled-ack watchdog within 30s").
//
// SRP (dev.md §2): this is pure data + pure mutators (Map insert /
// delete / lookup). No I/O, no proto, no Connect imports. The
// rpc/pty-attach.ts and rpc/ackpty.ts handlers compose this.

/**
 * Composite key string used as the registry Map key. Format:
 * `${principalKey}\x1f${sessionId}` — a single ASCII US (0x1f) separator
 * keeps the encoding unambiguous (neither principalKey nor sessionId
 * may contain US per their respective format docs: principalKey is
 * `<kind>:<uid|sid>`; sessionId is a ULID — both ASCII-safe).
 */
function registryKey(principalKey: string, sessionId: string): string {
  return `${principalKey}\x1f${sessionId}`;
}

const SUBSCRIBER_REGISTRY = new Map<string, Set<AckSubscriberState>>();

/**
 * Register a subscriber under the (principalKey, sessionId) tuple.
 * Insertion-ordered into a Set so {@link findFirstAckSubscriber} returns
 * the earliest-attached overlap candidate per spec §6.1.
 *
 * Idempotent on re-registering the same instance (Set semantics).
 */
export function registerAckSubscriber(
  principalKey: string,
  subscriber: AckSubscriberState,
): void {
  const key = registryKey(principalKey, subscriber.sessionId);
  let bucket = SUBSCRIBER_REGISTRY.get(key);
  if (bucket === undefined) {
    bucket = new Set<AckSubscriberState>();
    SUBSCRIBER_REGISTRY.set(key, bucket);
  }
  bucket.add(subscriber);
}

/**
 * Remove a subscriber from the registry. Called from the Attach
 * handler's `finally` block on stream teardown. Returns `true` if the
 * subscriber was registered (and is now removed); `false` if it was
 * already gone (idempotent — safe to re-enter from a defensive cleanup
 * path).
 */
export function unregisterAckSubscriber(
  principalKey: string,
  subscriber: AckSubscriberState,
): boolean {
  const key = registryKey(principalKey, subscriber.sessionId);
  const bucket = SUBSCRIBER_REGISTRY.get(key);
  if (bucket === undefined) return false;
  const removed = bucket.delete(subscriber);
  if (bucket.size === 0) {
    SUBSCRIBER_REGISTRY.delete(key);
  }
  return removed;
}

/**
 * Look up the FIRST (earliest-registered, still-attached) ack subscriber
 * for a (principalKey, sessionId). Returns `undefined` if no subscriber
 * is registered — the AckPty handler maps that to a no-op OK reply per
 * spec §6.2 (covers `requires_ack=false` Attach, post-disconnect race,
 * and badly-ordered clients uniformly).
 *
 * Set iteration order is insertion order in V8 / per ECMAScript spec —
 * FIRST is well-defined.
 */
export function findFirstAckSubscriber(
  principalKey: string,
  sessionId: string,
): AckSubscriberState | undefined {
  const bucket = SUBSCRIBER_REGISTRY.get(registryKey(principalKey, sessionId));
  if (bucket === undefined) return undefined;
  for (const sub of bucket) return sub;
  return undefined;
}

/**
 * Test seam: clear the registry. NOT for production use. Unit tests
 * call this in `afterEach` so subscribers from one `it` case do not
 * leak into the next.
 */
export function resetAckSubscriberRegistry(): void {
  SUBSCRIBER_REGISTRY.clear();
}
