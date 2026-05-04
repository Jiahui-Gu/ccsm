// Per-session in-memory snapshot + delta ring + subscriber broadcast.
//
// Spec ref: docs/superpowers/specs/2026-05-04-pty-attach-handler.md §2.3
// (daemon-main side per-session emitter), §2.4 (snapshot boundary
// semantics), §3.3 (synthetic initial snapshot at base_seq=0n on
// pty-host 'ready'), §9.2 T-PA-5 (this task).
//
// Task #354 — Wave 3 §6.9 sub-task 10 / T-PA-5 (wave-locked: paired with
// the host.ts wire-up that constructs / tears down the emitter alongside
// the pty-host child lifecycle).
//
// Scope (one PR = one concern):
//   - The PtySessionEmitter class: in-memory ring of the last
//     DELTA_RETENTION_SEQS deltas + the most recent snapshot reference +
//     a Set<PtyEventListener> for live broadcast.
//   - A module-level registry keyed by sessionId so the Attach handler
//     (T-PA-6, blocked on this PR) can look up the emitter by id without
//     plumbing it through every RPC handler context.
//   - The teardown path: close() broadcasts a structured 'closed' event
//     with a forever-stable reason string so the Attach handler (sink)
//     can translate it into Code.Canceled + ErrorDetail.code =
//     'pty.session_destroyed' at the wire boundary.
//
// NOT in this PR:
//   - The Attach handler that subscribes / translates events to PtyFrame
//     (T-PA-6 #355).
//   - The proto / Connect mapping — emitter speaks Uint8Array + bigint
//     only (spec §2.3: "no knowledge of proto, Connect, or the wire").
//   - awaitSnapshot() — promised in spec §2.3 / §3.3 but its consumer is
//     T-PA-6's Attach handler. Adding it here without a consumer would
//     either be untested API surface or force a fake-handler test that
//     duplicates T-PA-6's coverage. The Attach handler can layer it on
//     top of currentSnapshot() + subscribe() without changing this
//     module (currentSnapshot returns null, subscribe to wait for the
//     next 'snapshot' event). Keeping the surface minimal here removes
//     a hot-file follow-up rebase risk for T-PA-6.
//
// SRP (dev.md §2): this module is a (a) PRODUCER of PtyEvent broadcasts
// to subscribers — every IPC delta/snapshot from the pty-host child is
// fan-out via this single source. The host.ts wire-up is the upstream
// PRODUCER (it calls publishDelta / publishSnapshot from the IPC
// 'message' handler); the Attach handler (T-PA-6) is the SINK
// (subscribes, drains into the Connect server-stream).
//
// 5-tier "no wheel reinvention" judgement (dev.md §1 step 2):
//   1. Repo has no existing per-session in-memory ring + broadcaster
//      (greppable: no `PtySessionEmitter`, no `EventBus<Pty*>`). The
//      sessions/event-bus.ts pattern is the structural sibling but it
//      filters by principalKey, not session, and emits SessionEvent
//      proto shapes — different concern.
//   2. node:events EventEmitter could carry the broadcast but adds no
//      backpressure / no peek + would lose type safety on a per-event
//      union; for a single subscriber set with synchronous publish, a
//      Set<listener> is shorter than wrapping EventEmitter.
//   3. ack-state.ts already exports BoundedChannel + enqueueDroppingOldest
//      precisely so this emitter's ring uses the SAME ring primitive as
//      the per-subscriber channel — no parallel implementation drift
//      (per the BoundedChannel jsdoc).
//   4. No OSS analogue for a typed (snapshot, delta-ring, broadcast,
//      reason-coded close) bundle keyed by sessionId; the
//      forever-stable contract pieces (synthetic snapshot at base_seq=0,
//      single-snapshot-per-stream) are spec-specific.
//   5. Self-written, justified above. Test coverage is exercised
//      indirectly through host.ts wire-up specs (T-PA-5) and directly
//      through T-PA-6's Attach handler unit tests (which mock the
//      emitter against this surface). A standalone pty-emitter.spec.ts
//      already exists in spec §9.1 T-PA-4 for the ring + subscribe
//      invariants; it lives in the forward-safe wave that already
//      landed (#358 set).

import {
  BoundedChannel,
  ACK_CHANNEL_CAPACITY,
} from './ack-state.js';
import type {
  DeltaInMem,
  PtySnapshotInMem,
} from './attach-decider.js';
import type { DeltaMessage, SnapshotMessage } from './types.js';

/**
 * Forever-stable retention window for the per-session in-memory delta
 * ring. Pinned equal to {@link ACK_CHANNEL_CAPACITY} (== 4096) per spec
 * §4.5: a subscriber that hits its channel-full overflow path can
 * always reconnect with `since_seq = lastAckedSeq` and resume via
 * deltas-only because the emitter ring retained everything the channel
 * could have held. Mismatching the two would silently break the
 * "kick + reconnect" recovery invariant.
 *
 * Re-exported as `DELTA_RETENTION_SEQS` to match the spec's wording
 * (spec ch06 §4 / §5 / spec §2.3 use `DELTA_RETENTION_SEQS`; the
 * ack-state module uses `ACK_CHANNEL_CAPACITY` for the same number).
 */
export const DELTA_RETENTION_SEQS = ACK_CHANNEL_CAPACITY;

/**
 * Forever-stable reason code published on the {@link PtyEvent} 'closed'
 * variant. The Attach handler (T-PA-6 sink) maps this to
 * `Code.Canceled` + `ErrorDetail.code = 'pty.session_destroyed'` at the
 * wire boundary per spec §7.2 bullet 3.
 *
 * Carried as a string literal (not an enum) so the cross-module
 * coupling is greppable and so a v0.4 admin/destroy variant can land
 * additively without breaking existing readers.
 */
export type PtyEmitterCloseReason = 'pty.session_destroyed';

/**
 * Discriminated union of events broadcast to subscribers.
 *
 * - `snapshot` — published when the pty-host child emits a SnapshotMessage
 *   IPC. The first one (synthetic, baseSeq=0n) fires on `'ready'` per
 *   spec §3.3; subsequent ones fire on cadence / Resize per spec ch06 §4.
 *   Subscribers that opened mid-stream may choose to ignore these (spec
 *   §2.4: at-most-one snapshot per Attach stream; mid-stream snapshots
 *   are for hydration consumers, not the steady-state Attach handler).
 *
 * - `delta` — published for every DeltaMessage IPC. Synchronous fan-out
 *   from the IPC 'message' handler.
 *
 * - `session-state-changed` — published when the host wire-up flips the
 *   per-session SessionState (Task #385 / spec ch06 §4: 3-strike DEGRADED
 *   on snapshot write failures + 60s cooldown probe back to RUNNING).
 *   The Attach handler (T-PA-6 sink) translates this to a PtyFrame with
 *   the `session_state_changed` oneof variant on the wire. The `state`
 *   field carries the proto SessionState string name (e.g. `'DEGRADED'`,
 *   `'RUNNING'`) — kept as a string here so the emitter stays free of
 *   proto/Connect imports per spec §2.3 ("no knowledge of proto, Connect,
 *   or the wire").
 *
 * - `closed` — published exactly once when {@link PtySessionEmitter.close}
 *   fires (host.ts calls this on child exit). After this event no more
 *   events will be published; subscribers receive the final 'closed'
 *   event then their listener is dropped.
 */
export type PtyEvent =
  | { readonly kind: 'snapshot'; readonly snapshot: PtySnapshotInMem }
  | { readonly kind: 'delta'; readonly delta: DeltaInMem }
  | {
      readonly kind: 'session-state-changed';
      readonly state: 'RUNNING' | 'DEGRADED';
      readonly reason: string;
      readonly lastSeq: bigint;
      /**
       * Daemon wall-clock millis at which the transition was decided.
       * Named `sinceUnixMs` (not `tsUnixMs`) because the field semantically
       * marks the moment the new state began — UIs computing a "DEGRADED
       * for 12s" timer subtract this from the current clock. Mapped to
       * the `ts_unix_ms` proto field at the wire boundary by the Attach
       * handler (T-PA-6 sink).
       */
      readonly sinceUnixMs: number;
    }
  | { readonly kind: 'closed'; readonly reason: PtyEmitterCloseReason };

/**
 * A subscriber's listener callback. Fires synchronously from inside the
 * `publish*` call (which itself fires synchronously from the IPC
 * 'message' handler in host.ts). Listeners MUST NOT throw — they SHOULD
 * route their work into a bounded channel (see ack-state.ts) and let the
 * Attach handler's async loop drain it.
 *
 * If a listener does throw, the emitter logs to console.error and
 * continues to the next listener. We do NOT remove a throwing listener
 * automatically — leaving it in lets the Attach handler observe further
 * events (which may be the very fix it's looking for); the right cure
 * for repeated throws is to unsubscribe, not for the producer to
 * second-guess.
 */
export type PtyEventListener = (event: PtyEvent) => void;

/**
 * Per-session in-memory ring + snapshot + broadcaster.
 *
 * One instance per session, owned by the daemon main process for the
 * lifetime of the pty-host child (constructed when the child sends
 * `'ready'`, closed when the child exits). The host.ts wire-up calls
 * `publishSnapshot` / `publishDelta` from the IPC 'message' handler;
 * the Attach handler (T-PA-6) calls `subscribe` / `currentSnapshot` /
 * `deltasSince`.
 *
 * The class is intentionally a value object with no async methods — all
 * I/O lives in the host.ts wire-up. This keeps the emitter itself unit-
 * testable without mocking IPC, and keeps the `'message'` handler in
 * host.ts a single synchronous code path.
 */
export class PtySessionEmitter {
  readonly sessionId: string;
  readonly capacity: number;

  // Most recent snapshot, or null before the synthetic initial one fires
  // (spec §3.3 first-snapshot race window). Replaced on every
  // publishSnapshot.
  #currentSnapshot: PtySnapshotInMem | null = null;

  // Highest seq ever published via publishDelta. Tracked so deltasSince
  // and the §3.4 decider math can read it in O(1) without scanning the
  // ring.
  #currentMaxSeq: bigint = 0n;

  // FIFO ring of the last `capacity` deltas. enqueueDroppingOldest is
  // used so the producer never blocks; the spec §2.4 prune happens via
  // the same drop-oldest path on every publishDelta past the cap. The
  // ack-state BoundedChannel docstring explicitly endorses this reuse.
  readonly #ring: BoundedChannel<DeltaInMem>;

  // Live subscribers. Set (not array) so unsubscribe is O(1).
  readonly #subscribers: Set<PtyEventListener> = new Set();

  // True after close() has fired. Subsequent publish*/subscribe calls
  // are no-ops so the host.ts caller doesn't have to gate every IPC
  // route. close() itself is idempotent.
  #closed = false;

  constructor(sessionId: string, capacity: number = DELTA_RETENTION_SEQS) {
    this.sessionId = sessionId;
    this.capacity = capacity;
    this.#ring = new BoundedChannel<DeltaInMem>(capacity);
  }

  /**
   * Most recent snapshot in memory, or `null` if none has been published
   * yet (spec §3.3 first-snapshot race). Returned by reference; callers
   * MUST treat the bytes as immutable (they originate from the IPC
   * payload and are shared across subscribers).
   */
  currentSnapshot(): PtySnapshotInMem | null {
    return this.#currentSnapshot;
  }

  /**
   * Highest seq ever broadcast. `0n` before the first delta. Reads in
   * O(1); the §3.4 attach decider needs this value synchronously.
   */
  currentMaxSeq(): bigint {
    return this.#currentMaxSeq;
  }

  /**
   * Lowest seq still in the in-memory ring. `0n` before any deltas; once
   * deltas exist this is `max(1n, currentMaxSeq - capacity + 1n)` (the
   * formula from spec §3.4 / attach-decider jsdoc). The Attach handler
   * (T-PA-6 sink) feeds this into `decideAttachResume` for the
   * `refused_too_far_behind` branch.
   *
   * Computed (not cached) because the read site is exactly once per
   * Attach RPC; caching would just defer the bigint subtraction.
   */
  oldestRetainedSeq(): bigint {
    if (this.#currentMaxSeq === 0n) {
      return 0n;
    }
    const cap = BigInt(this.capacity);
    const candidate = this.#currentMaxSeq - cap + 1n;
    return candidate > 1n ? candidate : 1n;
  }

  /**
   * Synchronously read the deltas in `(sinceSeq, currentMaxSeq]` from
   * the ring. Returns `'out-of-window'` if `sinceSeq < oldestRetainedSeq`
   * (the Attach handler maps that to `Code.OutOfRange` per spec §3.2;
   * this method itself stays decider-pure).
   *
   * Empty array (NOT 'out-of-window') is returned when
   * `sinceSeq === currentMaxSeq` — that's the deltas-only-with-no-gap
   * case (spec §3.4: "sinceSeq == currentMaxSeq is valid here and yields
   * an empty deltas slice").
   *
   * Implementation note: walks the ring's underlying buffer via the
   * peek+iterator pattern would be more O(1) but the BoundedChannel
   * primitive does NOT expose iteration (deliberately — adding it would
   * leak ring state to all callers). We materialize to an array; the
   * upper bound is `capacity == 4096` deltas, well below any pathological
   * cost. For the steady-state happy path the slice is small (<256 per
   * spec ch06 §4 cadence).
   */
  deltasSince(sinceSeq: bigint): readonly DeltaInMem[] | 'out-of-window' {
    if (this.#currentMaxSeq === 0n) {
      // No deltas yet. Any sinceSeq > 0n is a future-seq case (handled
      // by the decider, not here); sinceSeq == 0n yields an empty
      // slice (no deltas to replay).
      return sinceSeq === 0n ? [] : 'out-of-window';
    }
    if (sinceSeq < this.oldestRetainedSeq()) {
      return 'out-of-window';
    }
    if (sinceSeq >= this.#currentMaxSeq) {
      return [];
    }
    // Drain the ring into a flat array (the only way to read the
    // BoundedChannel without exposing its internals), filter to
    // (sinceSeq, currentMaxSeq], then re-enqueue. This is destructive-
    // looking but the channel stays the source of truth — we re-add
    // exactly what we removed. The cost is O(capacity); see comment
    // above re: bound.
    const drained: DeltaInMem[] = [];
    while (true) {
      const item = this.#ring.dequeue();
      if (item === undefined) break;
      drained.push(item);
    }
    const result: DeltaInMem[] = [];
    for (const d of drained) {
      this.#ring.enqueue(d); // re-enqueue everything; the ring stays whole
      if (d.seq > sinceSeq) {
        result.push(d);
      }
    }
    return result;
  }

  /**
   * Subscribe to live broadcast. Returns an unsubscribe function. After
   * `close()` has fired, subscribe is a no-op (returns a no-op
   * unsubscribe) — the caller will have already received (or be about
   * to receive synchronously, depending on subscribe-during-close
   * ordering) the final 'closed' event via prior subscriptions.
   *
   * The listener fires synchronously from `publish*` calls, which
   * themselves fire synchronously from the IPC 'message' handler in
   * host.ts. Listeners MUST be non-blocking; route work into a bounded
   * channel and let the Attach handler's async loop drain it.
   */
  subscribe(listener: PtyEventListener): () => void {
    if (this.#closed) {
      // Late subscriber after close — fire 'closed' once (so the
      // subscriber's teardown path runs) then return a no-op unsubscribe.
      try {
        listener({ kind: 'closed', reason: 'pty.session_destroyed' });
      } catch (err) {
        // Listener bug; log and swallow per the listener-throws contract.
        // eslint-disable-next-line no-console
        console.error(
          `[ccsm-daemon] PtySessionEmitter(${this.sessionId}): late subscriber listener threw on 'closed' event`,
          err,
        );
      }
      return () => {};
    }
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  /**
   * Subscriber count seam — exposed for daemon-boot-e2e #5 (spec §8
   * disconnect cleanup): "open Attach + abort → emitter.subscriberCount
   * === 0 within 100ms". The Attach handler (T-PA-6) is responsible for
   * calling the unsubscribe fn from the abort path; this method only
   * exposes the count so the test can assert convergence without
   * reaching into the private Set.
   */
  subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * True after `close()` has fired. host.ts may use this from the IPC
   * 'message' handler to skip publish* on already-closed sessions
   * (e.g. a stray IPC arriving between exit-signal and full teardown).
   */
  isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Ingest a SnapshotMessage from the pty-host child. Replaces
   * `currentSnapshot` and broadcasts a 'snapshot' event. The synthetic
   * initial snapshot (spec §3.3, baseSeq=0n) is just a normal call to
   * this method with that baseSeq value.
   *
   * Spec §2.4 atomic step "replace currentSnapshot reference + prune
   * the ring + publish event" — pruning happens at the ring level via
   * BoundedChannel.enqueueDroppingOldest on every publishDelta, NOT
   * here. The reason: the prune rule is `seq < baseSeq -
   * DELTA_RETENTION_SEQS + 1`, and once the ring is sized to capacity
   * the drop-oldest-on-enqueue policy enforces exactly that at the
   * tighter cap of `currentMaxSeq - capacity + 1`. Combining the two
   * (snapshot-prune AND enqueue-drop) would double-account; only one
   * is needed. We choose enqueue-drop because it's continuous (no
   * burst at snapshot boundaries) and the per-snapshot cost stays O(1).
   */
  publishSnapshot(msg: SnapshotMessage): void {
    if (this.#closed) return;
    // Defensive payload check — host.ts's `isChildToHostMessage` only
    // validates the discriminant for the snapshot kind (the IPC payload
    // shape was locked in T-PA-1 but a malformed child or a test fixture
    // that sends `{kind:'snapshot'}` without payload fields would
    // otherwise feed `undefined` into `currentSnapshot`). Reject quietly
    // and log; the lifecycle stays unaffected.
    if (
      typeof msg.baseSeq !== 'bigint' ||
      typeof msg.schemaVersion !== 'number' ||
      msg.geometry === undefined ||
      msg.screenState === undefined
    ) {
      // eslint-disable-next-line no-console
      console.error(
        `[ccsm-daemon] PtySessionEmitter(${this.sessionId}): malformed snapshot IPC; missing payload fields (baseSeq=${String(msg.baseSeq)}, schemaVersion=${String(msg.schemaVersion)})`,
      );
      return;
    }
    const snapshot: PtySnapshotInMem = {
      baseSeq: msg.baseSeq,
      geometry: msg.geometry,
      screenState: msg.screenState,
      schemaVersion: msg.schemaVersion,
    };
    this.#currentSnapshot = snapshot;
    this.#broadcast({ kind: 'snapshot', snapshot });
  }

  /**
   * Ingest a DeltaMessage from the pty-host child. Appends to the ring
   * (drop-oldest on overflow per the BoundedChannel reuse pattern),
   * advances `currentMaxSeq`, broadcasts a 'delta' event.
   *
   * Validates strict monotonicity: `seq > currentMaxSeq` is the
   * forever-stable invariant from spec §2.1 ("monotonically-increasing
   * per session, never reused, never gapped"). A violation is a
   * pty-host-child bug; we log and DROP the offending delta rather
   * than crash the daemon, because the alternative — propagating a
   * gap to subscribers — corrupts every renderer's xterm state. This
   * is conservative: the renderer will eventually time out / reattach
   * with `since_seq = lastAppliedSeq`, recovering via the deltas-only
   * branch (or `refused_too_far_behind` if the gap was huge).
   */
  publishDelta(msg: DeltaMessage): void {
    if (this.#closed) return;
    // Same defensive check as publishSnapshot — guard against malformed
    // IPC payloads from test fixtures or future child-side bugs.
    if (
      typeof msg.seq !== 'bigint' ||
      typeof msg.tsUnixMs !== 'bigint' ||
      msg.payload === undefined
    ) {
      // eslint-disable-next-line no-console
      console.error(
        `[ccsm-daemon] PtySessionEmitter(${this.sessionId}): malformed delta IPC; missing payload fields (seq=${String(msg.seq)}, tsUnixMs=${String(msg.tsUnixMs)})`,
      );
      return;
    }
    if (msg.seq <= this.#currentMaxSeq) {
      // eslint-disable-next-line no-console
      console.error(
        `[ccsm-daemon] PtySessionEmitter(${this.sessionId}): non-monotonic delta seq=${msg.seq} <= currentMaxSeq=${this.#currentMaxSeq}; dropping (pty-host child invariant violation)`,
      );
      return;
    }
    const delta: DeltaInMem = {
      seq: msg.seq,
      tsUnixMs: msg.tsUnixMs,
      payload: msg.payload,
    };
    this.#ring.enqueueDroppingOldest(delta);
    this.#currentMaxSeq = msg.seq;
    this.#broadcast({ kind: 'delta', delta });
  }

  /**
   * Broadcast a per-session SessionState transition. Task #385 / spec
   * ch06 §4: the host wire-up calls this when the {@link decideDegraded}
   * decider flips between RUNNING and DEGRADED (3-strike snapshot write
   * failure → DEGRADED + 60s cooldown; cooldown elapsed + retry succeeds
   * → RUNNING).
   *
   * Unlike `publishSnapshot` / `publishDelta` this method does NOT touch
   * the in-memory ring or `currentSnapshot` — SessionState transitions
   * are out-of-band signals that subscribers may surface in the UI but
   * do NOT alter the per-session delta seq stream (deltas continue
   * flowing from the in-memory ring throughout DEGRADED cooldown per
   * spec ch06 §4). The Attach handler (T-PA-6 sink) translates this
   * event into `PtyFrame.session_state_changed` on the wire.
   *
   * Idempotent on already-closed emitters: a stray transition arriving
   * after `close()` is dropped silently.
   */
  publishSessionStateChanged(args: {
    readonly state: 'RUNNING' | 'DEGRADED';
    readonly reason: string;
    readonly sinceUnixMs: number;
  }): void {
    if (this.#closed) return;
    this.#broadcast({
      kind: 'session-state-changed',
      state: args.state,
      reason: args.reason,
      // Snapshot the current max seq at publish time so subscribers can
      // correlate the transition with their applied-delta watermark.
      lastSeq: this.#currentMaxSeq,
      sinceUnixMs: args.sinceUnixMs,
    });
  }

  /**
   * Tear down the emitter: broadcast a final 'closed' event to every
   * subscriber (so the Attach handler can map it to Code.Canceled +
   * `pty.session_destroyed` per spec §7.2), drop all subscribers, and
   * latch the closed flag so subsequent publish/subscribe calls become
   * no-ops.
   *
   * Idempotent: a second call is a no-op (returns immediately). This
   * matches the host.ts caller pattern where both the IPC disconnect
   * path and the explicit teardown path may both fire close().
   *
   * Subscribers are dropped AFTER the broadcast so a subscriber that
   * tries to unsubscribe from inside its 'closed' handler doesn't
   * trigger ConcurrentModification. We snapshot the Set into an array
   * before iteration for the same reason.
   */
  close(reason: PtyEmitterCloseReason = 'pty.session_destroyed'): void {
    if (this.#closed) return;
    this.#closed = true;
    const event: PtyEvent = { kind: 'closed', reason };
    // Snapshot subscribers BEFORE clearing so concurrent unsubscribe
    // calls from inside a listener don't mutate during iteration.
    const subscribers = [...this.#subscribers];
    this.#subscribers.clear();
    for (const listener of subscribers) {
      try {
        listener(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[ccsm-daemon] PtySessionEmitter(${this.sessionId}): subscriber listener threw on 'closed' event`,
          err,
        );
      }
    }
  }

  // Internal: synchronous fan-out to every subscriber. Snapshot the
  // Set into an array before iteration so a listener that calls
  // unsubscribe (or throws) cannot break the iteration order.
  #broadcast(event: PtyEvent): void {
    const subscribers = [...this.#subscribers];
    for (const listener of subscribers) {
      try {
        listener(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[ccsm-daemon] PtySessionEmitter(${this.sessionId}): subscriber listener threw on '${event.kind}' event`,
          err,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level registry — sessionId → PtySessionEmitter
// ---------------------------------------------------------------------------
//
// The Attach RPC handler (T-PA-6, blocked on this PR) needs to look up
// the emitter for a given AttachRequest.session_id. Plumbing the map
// through every RPC handler context would couple the router to the
// pty-host module's internals; a module-level registry keeps the
// coupling at exactly one symbol (`getEmitter`) on each side.
//
// Thread-safety: Node is single-threaded; all access happens on the
// main thread (IPC 'message' is on the event loop, RPC handlers run on
// the event loop). No locking needed.
//
// The registry is internal state of this module — it's NOT a Singleton
// in the broader-architecture sense. Tests that want isolation can call
// resetEmitterRegistry() in afterEach (see the export below).

const REGISTRY = new Map<string, PtySessionEmitter>();

/**
 * Register a new emitter for a session. Called from host.ts on
 * pty-host child `'ready'`. Throws if an emitter already exists for
 * the session — a duplicate is a programming error in the host wire-up
 * (a session id is a ULID; collisions in normal use mean the daemon is
 * trying to spawn two children for the same session).
 *
 * The host.ts caller is responsible for the matched
 * {@link unregisterEmitter} on child exit.
 */
export function registerEmitter(emitter: PtySessionEmitter): void {
  if (REGISTRY.has(emitter.sessionId)) {
    throw new Error(
      `PtySessionEmitter registry: duplicate sessionId ${emitter.sessionId} ` +
        '(host.ts wire-up bug — registerEmitter called twice without an intervening unregisterEmitter)',
    );
  }
  REGISTRY.set(emitter.sessionId, emitter);
}

/**
 * Remove an emitter from the registry. Called from host.ts on pty-host
 * child exit (right after emitter.close()). Idempotent: returns false
 * if the session was never registered (or already removed) so the
 * host.ts teardown path can be safely re-entered.
 */
export function unregisterEmitter(sessionId: string): boolean {
  return REGISTRY.delete(sessionId);
}

/**
 * Look up the emitter for a session id. Returns `undefined` if no
 * emitter exists for the id (session was never created, or has been
 * destroyed). The Attach RPC handler (T-PA-6) maps `undefined` to
 * `Code.NotFound` + `ErrorDetail.code = 'pty.session_not_found'` (the
 * per-spec mapping; landed in T-PA-6's PR, not here).
 */
export function getEmitter(sessionId: string): PtySessionEmitter | undefined {
  return REGISTRY.get(sessionId);
}

/**
 * Test seam: clear the entire registry. NOT for production use. Unit
 * tests in `__tests__/` may call this in `afterEach` to ensure no
 * cross-test leakage when multiple emitters are constructed in a single
 * vitest worker.
 */
export function resetEmitterRegistry(): void {
  // Close every emitter so subscribers in any straggler tests get the
  // 'closed' event (they shouldn't have any, but the bookkeeping is
  // cheap and matches the production teardown ordering).
  for (const emitter of REGISTRY.values()) {
    try {
      emitter.close();
    } catch {
      // Best-effort cleanup; tests don't care if a stray subscriber threw.
    }
  }
  REGISTRY.clear();
}
