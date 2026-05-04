// PtyService.Attach handler — Connect server-streaming sink that maps an
// in-memory PtySessionEmitter (from `pty-host/pty-emitter.ts`, landing in
// PR #1027 / T-PA-5) onto the wire `PtyFrame` proto. Spec ref:
// docs/superpowers/specs/2026-05-04-pty-attach-handler.md §2-§5, §9.2 T-PA-6.
//
// Task #355 — Wave 3 §6.9 sub-task 10 / T-PA-6 (wave-locked: modifies
// rpc/router.ts to register the overlay).
//
// SRP layering — three roles, kept separate (dev.md §2):
//   - decider:  `decideAttachResume` (already lives in
//               `pty-host/attach-decider.ts`, T-PA-2 / PR shipped). This
//               module imports the pure verdict and translates each
//               variant into a wire action.
//   - producer: `PtySessionEmitterLike.subscribe(listener)` — the per-
//               session in-memory ring + snapshot + broadcaster owned by
//               the daemon main process (T-PA-5 / pty-host wire-up).
//               This handler subscribes; the emitter pushes; the handler's
//               consumer drains a bounded buffer onto the Connect stream.
//   - sink:     `makeAttachHandler(deps)` — the only place that constructs
//               `ConnectError`, `create(PtyFrameSchema, ...)`, and yields
//               onto the AsyncGenerator Connect-ES v2 server-streaming
//               handlers must return. Reads PRINCIPAL_KEY from
//               HandlerContext, runs the decider, owns AbortSignal
//               teardown.
//
// Why deps-injected `getEmitter` (NOT a direct module import of
// `pty-host/pty-emitter.ts`'s `getEmitter` symbol):
//   - PR #1027 (T-PA-5 PtySessionEmitter wire-up) is OPEN at the time
//     this PR opens; importing the symbol directly would force this PR
//     to wait on #1027. Spec §9.3 packs T-PA-5 → T-PA-6 in adjacent
//     waves but the manager's "forward-safe over wave-locked" rule lets
//     this PR land independently as long as the seam is one symbol on
//     each side.
//   - The `PtySessionEmitterLike` shape below mirrors PR #1027's
//     `PtySessionEmitter` exact public surface (the methods this handler
//     needs); when #1027 lands, daemon startup wiring (`index.ts`)
//     supplies `getEmitter: (id) => ptyEmitterRegistry.getEmitter(id)`
//     and TypeScript structural typing matches one-shot. No follow-up
//     refactor of this file. The dual import path (deps for prod,
//     fakes for tests) also matches `makeWatchSessionsHandler(deps)`
//     and `makeHelloHandler(deps)` precedent — no new pattern.
//
// Why we re-implement `awaitSnapshot` here (not on the emitter):
//   - PR #1027 deliberately omitted `awaitSnapshot()` from the emitter
//     surface (see its file header §9.1 commentary): "The Attach handler
//     can layer it on top of currentSnapshot() + subscribe() without
//     changing this module." Layering it here keeps the emitter minimal
//     and the await semantics (signal aborts, session-ends-before-first-
//     snapshot) co-located with the handler that owns the AbortSignal.
//
// 5-tier "no wheel reinvention" judgement (dev.md §1 step 2):
//   1. Repo `subscribeAsAsyncIterable` in sessions/watch-sessions.ts is
//      the structural sibling — bus → AsyncIterable adapter with
//      bounded buffer, abort-signal teardown, ConnectError on overflow.
//      We do NOT extract a shared helper because:
//      (a) the per-event mapping differs (SessionEvent vs PtyFrame oneof);
//      (b) the snapshot-then-deltas warm-up has no analogue in
//          watch-sessions; and
//      (c) the spec §5 cleanup contract calls for explicit
//          subscribe/unsubscribe pairing here too — duplicating the
//          25-line adapter is clearer than a generic that has to handle
//          both shapes (dev.md §1: "two copies are clearer than a
//          shared abstraction").
//   2. node:events `on(emitter, evt, { signal })` would adapt an
//      EventEmitter to AsyncIterable but the PtySessionEmitter is
//      bespoke (Set<listener> + ring) — wrapping it in EventEmitter just
//      to use the stdlib adapter is more code than the local adapter.
//   3. ack-state.ts (PR shipped) already supplies the BoundedChannel
//      primitive AND the `AckSubscriberState` decider. The
//      `requires_ack=true` path uses both verbatim.
//   4. No OSS lib provides "snapshot-then-deltas server stream with
//      per-frame ack and signal teardown" — every concern listed above
//      is spec-specific.
//   5. Self-written; the surface is small (~250 LoC including the
//      adapter) and every block has a §-numbered spec ref.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import { randomUUID } from 'node:crypto';

import {
  ErrorDetailSchema,
  PtyDeltaSchema,
  PtyFrameSchema,
  PtyGeometrySchema,
  PtySessionStateChangedSchema,
  PtySnapshotSchema,
  SessionState,
  type AckPtyRequest,
  type AckPtyResponse,
  type AttachRequest,
  type PtyFrame,
  type PtyService,
} from '@ccsm/proto';
import { AckPtyResponseSchema, RequestMetaSchema } from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey as toPrincipalKey } from '../auth/index.js';
import {
  decideAttachResume,
  type DeltaInMem,
  type PtySnapshotInMem,
  type ResumeDecision,
} from '../pty-host/attach-decider.js';
import {
  ACK_CHANNEL_CAPACITY,
  AckSubscriberState,
  BoundedChannel,
  findFirstAckSubscriber,
  registerAckSubscriber,
  unregisterAckSubscriber,
} from '../pty-host/ack-state.js';

// ---------------------------------------------------------------------------
// Emitter port — structural shape this handler needs from the per-session
// in-memory broadcaster. Mirrors the `PtySessionEmitter` class landing in
// PR #1027 (T-PA-5) so production wiring can pass that class directly via
// `getEmitter` without an adapter, and tests can pass an inline fake
// without depending on PR #1027.
// ---------------------------------------------------------------------------

/**
 * Discriminated event union the emitter broadcasts to subscribers.
 *
 * Mirrors PR #1027's `PtyEvent` exactly — the structural type lets a
 * production `PtySessionEmitter` (T-PA-5) be passed in via
 * {@link PtyAttachDeps.getEmitter} with no adapter.
 *
 * Spec §2.3-§2.4 — `'snapshot'` events fire on every snapshot
 * publication (steady-state Attach IGNORES these per §2.4 "at-most-one
 * snapshot per Attach"; only the warm-up snapshot is yielded onto the
 * wire). `'delta'` events fire for every IPC delta.
 * `'session-state-changed'` events fire whenever the host wire-up flips
 * the per-session SessionState (Task #385 / spec ch06 §4: 3-strike
 * DEGRADED + 60s cooldown probe back to RUNNING) — translated to
 * `PtyFrame.session_state_changed` on the wire by this handler.
 * `'closed'` fires exactly once on emitter teardown.
 */
export type PtyEmitterEvent =
  | { readonly kind: 'snapshot'; readonly snapshot: PtySnapshotInMem }
  | { readonly kind: 'delta'; readonly delta: DeltaInMem }
  | {
      readonly kind: 'session-state-changed';
      readonly state: 'RUNNING' | 'DEGRADED';
      readonly reason: string;
      readonly lastSeq: bigint;
      readonly sinceUnixMs: number;
    }
  | { readonly kind: 'closed'; readonly reason: 'pty.session_destroyed' };

export type PtyEmitterListener = (event: PtyEmitterEvent) => void;

/**
 * Subset of `PtySessionEmitter`'s public surface this handler uses.
 * Structural-typed so the production class (PR #1027) plugs in via
 * {@link PtyAttachDeps.getEmitter} with no glue layer.
 *
 * Method docs cross-reference the canonical implementation in
 * `pty-host/pty-emitter.ts` (PR #1027) — when that PR lands, the
 * comments there are the source of truth; this interface is just the
 * type shadow.
 */
export interface PtySessionEmitterLike {
  /** Session ULID. Used for log lines and structural keying. */
  readonly sessionId: string;
  /**
   * Most recent snapshot in memory, or `null` if the synthetic initial
   * snapshot has not yet been captured (§3.3 first-snapshot race).
   * Returned by reference; the bytes MUST be treated as immutable.
   */
  currentSnapshot(): PtySnapshotInMem | null;
  /** Highest seq ever broadcast. `0n` before the first delta. */
  currentMaxSeq(): bigint;
  /**
   * Lowest seq still in the in-memory ring (== `max(1n, currentMaxSeq -
   * N + 1n)` once N deltas exist; `0n` before any deltas).
   */
  oldestRetainedSeq(): bigint;
  /**
   * Synchronously read deltas in `(sinceSeq, currentMaxSeq]`. Returns
   * `'out-of-window'` if `sinceSeq < oldestRetainedSeq` (handler maps
   * to `Code.OutOfRange`).
   */
  deltasSince(sinceSeq: bigint): readonly DeltaInMem[] | 'out-of-window';
  /**
   * Subscribe to live broadcast. Returns an unsubscribe function. The
   * listener fires SYNCHRONOUSLY from inside the emitter's `publish*`
   * call (which is called from the IPC `'message'` handler).
   *
   * Late subscribers (after `close()` has fired) MUST receive a single
   * 'closed' event then a no-op unsubscribe — matches PR #1027 contract.
   */
  subscribe(listener: PtyEmitterListener): () => void;
  /** True iff `close()` has fired. */
  isClosed(): boolean;
}

// ---------------------------------------------------------------------------
// Handler deps
// ---------------------------------------------------------------------------

/**
 * Dependencies the Attach handler factory needs.
 *
 * `getEmitter` is the seam to PR #1027's module-level
 * `PtySessionEmitter` registry. Production startup wires it as
 * `(sid) => ptyEmitterRegistry.getEmitter(sid)`; tests pass an inline
 * map-backed fake. Returning `undefined` means "no session by that id"
 * — the handler maps to `Code.NotFound` + `pty.session_not_found`.
 */
export interface PtyAttachDeps {
  readonly getEmitter: (
    sessionId: string,
  ) => PtySessionEmitterLike | undefined;
}

// ---------------------------------------------------------------------------
// Forever-stable error code strings — local to this handler.
//
// `errors.ts` (`STANDARD_ERROR_MAP`) is the cross-handler registry but
// its closed-enum is intentionally minimal (4 strings as of T2.5) and
// this handler ships THREE pty-specific codes that the spec pins to
// this single call site (none used by other RPCs). Inlining the
// ConnectError construction keeps the registry from accreting per-
// handler one-offs while still letting the spec-pinned strings be a
// closed union the test suite can assert on.
// ---------------------------------------------------------------------------

/**
 * The forever-stable `ErrorDetail.code` strings this handler may emit.
 * Spec §3.2, §3.4, §7.2, §1 (CreateSession not_found path is in T-PA-7;
 * the not_found here surfaces "session id never existed OR was already
 * destroyed"). `pty.subscriber_channel_full` lands when
 * `requires_ack=true` and the per-subscriber bounded channel overflows
 * (spec §4.3).
 */
export type PtyAttachErrorCode =
  | 'pty.session_not_found'
  | 'pty.attach_too_far_behind'
  | 'pty.attach_future_seq'
  | 'pty.session_destroyed'
  | 'pty.subscriber_channel_full'
  | 'pty.ack_overrun'
  | 'pty.ack_regress';

const PTY_ERROR_CODE_TO_CONNECT: Record<PtyAttachErrorCode, Code> = {
  // §1 (this handler) — session id resolves to no live emitter. Map to
  // NotFound so a client can distinguish "you typo'd" from
  // OutOfRange / InvalidArgument.
  'pty.session_not_found': Code.NotFound,
  // §3.2 — refused_too_far_behind verdict.
  'pty.attach_too_far_behind': Code.OutOfRange,
  // §3.4 — refused_protocol_violation verdict.
  'pty.attach_future_seq': Code.InvalidArgument,
  // §7.2 — emitter close() fires under the open Attach (DestroySession
  // wins the race).
  'pty.session_destroyed': Code.Canceled,
  // §4.3 — `requires_ack=true` per-subscriber channel overflow.
  'pty.subscriber_channel_full': Code.ResourceExhausted,
  // §6.1 — AckPty applied_seq > lastDeliveredSeq (client claimed to
  // have applied a frame the daemon never sent).
  'pty.ack_overrun': Code.InvalidArgument,
  // §6.1 — AckPty applied_seq < lastAckedSeq (regressing ack).
  'pty.ack_regress': Code.InvalidArgument,
};

function ptyError(
  code: PtyAttachErrorCode,
  message: string,
  extra: Readonly<Record<string, string>> = {},
): ConnectError {
  const connectCode = PTY_ERROR_CODE_TO_CONNECT[code];
  return new ConnectError(message, connectCode, undefined, [
    {
      desc: ErrorDetailSchema,
      value: {
        code,
        message,
        extra: { ...extra },
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Frame mappers (in-memory shape → proto)
// ---------------------------------------------------------------------------

/**
 * Build a `PtyFrame.snapshot` proto from an in-memory snapshot record.
 * Pure, exported for unit tests.
 */
export function snapshotToFrame(snapshot: PtySnapshotInMem): PtyFrame {
  return create(PtyFrameSchema, {
    kind: {
      case: 'snapshot',
      value: create(PtySnapshotSchema, {
        baseSeq: snapshot.baseSeq,
        geometry: create(PtyGeometrySchema, {
          cols: snapshot.geometry.cols,
          rows: snapshot.geometry.rows,
        }),
        screenState: snapshot.screenState,
        schemaVersion: snapshot.schemaVersion,
      }),
    },
  });
}

/**
 * Build a `PtyFrame.delta` proto from an in-memory delta record. Pure,
 * exported for unit tests.
 */
export function deltaToFrame(delta: DeltaInMem): PtyFrame {
  return create(PtyFrameSchema, {
    kind: {
      case: 'delta',
      value: create(PtyDeltaSchema, {
        seq: delta.seq,
        payload: delta.payload,
        tsUnixMs: delta.tsUnixMs,
      }),
    },
  });
}

/**
 * Map an emitter `'session-state-changed'` event to the
 * `PtyFrame.session_state_changed` oneof variant. Spec ch06 §4 / pty.proto
 * §F8 — out-of-band per-session SessionState transition signal (today
 * RUNNING ↔ DEGRADED). Pure, exported for unit tests.
 *
 * The emitter carries `state` as the string `'RUNNING' | 'DEGRADED'` so it
 * stays free of proto/Connect imports (per spec §2.3); this sink is the
 * single place where the string is translated to the proto enum value.
 */
export function sessionStateChangedToFrame(event: {
  readonly state: 'RUNNING' | 'DEGRADED';
  readonly reason: string;
  readonly lastSeq: bigint;
  readonly sinceUnixMs: number;
}): PtyFrame {
  // String → SessionState enum. Closed union of two strings; any future
  // additions to PtyEvent's session-state-changed variant must be added
  // here too (TS exhaustive switch keeps both sides honest).
  let stateEnum: SessionState;
  switch (event.state) {
    case 'RUNNING':
      stateEnum = SessionState.RUNNING;
      break;
    case 'DEGRADED':
      stateEnum = SessionState.DEGRADED;
      break;
    default: {
      const _exhaustive: never = event.state;
      throw new Error(
        `unhandled SessionState string: ${String(_exhaustive)}`,
      );
    }
  }
  return create(PtyFrameSchema, {
    kind: {
      case: 'sessionStateChanged',
      value: create(PtySessionStateChangedSchema, {
        state: stateEnum,
        reason: event.reason,
        lastSeq: event.lastSeq,
        tsUnixMs: BigInt(event.sinceUnixMs),
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// awaitSnapshot — local (spec §3.3 first-snapshot race window)
// ---------------------------------------------------------------------------

/**
 * Resolve with the emitter's current snapshot. If `currentSnapshot()`
 * is non-null, resolves SYNCHRONOUSLY (microtask) with it. Otherwise
 * subscribes and resolves with the first `'snapshot'` event.
 *
 * Spec §3.3 — the pty-host child is REQUIRED to emit a synthetic
 * snapshot at `'ready'` BEFORE any deltas. With T-PA-8 in place every
 * Attach for a live session sees a non-null `currentSnapshot()` on the
 * first call — but the daemon-boot race window (CreateSession returns
 * after `'ready'`; the IPC fan-out into the emitter is also synchronous
 * but happens on the next tick) makes the null case observable. The
 * await path closes the race deterministically.
 *
 * Rejects if:
 *   - the emitter is closed before the first snapshot ever arrives
 *     (`'closed'` event observed) — `Code.Canceled` +
 *     `pty.session_destroyed`, matching the steady-state DestroySession
 *     mapping (§7.2);
 *   - the abort signal fires before the first snapshot — propagates
 *     `signal.reason ?? AbortError`; the handler catches and re-throws
 *     as Connect's standard cancellation (caller hands the abort to
 *     Connect by returning the rejected promise into its for-await loop).
 *
 * Exported for unit tests.
 */
export function awaitSnapshot(
  emitter: PtySessionEmitterLike,
  signal: AbortSignal | undefined,
): Promise<PtySnapshotInMem> {
  // Fast path: non-null already.
  const current = emitter.currentSnapshot();
  if (current !== null) {
    return Promise.resolve(current);
  }
  // Already-closed emitter — late subscriber path. The spec calls this
  // a "session ended before first snapshot" failure (e.g. claude
  // crashed during init). Map to canceled per §7.2.
  if (emitter.isClosed()) {
    return Promise.reject(
      ptyError(
        'pty.session_destroyed',
        `session ${emitter.sessionId} ended before its first snapshot`,
      ),
    );
  }
  // Already-aborted signal — short-circuit before subscribing.
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Attach aborted before first snapshot'),
    );
  }

  return new Promise<PtySnapshotInMem>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let detachAbort: (() => void) | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (unsubscribe !== null) {
        const u = unsubscribe;
        unsubscribe = null;
        u();
      }
      if (detachAbort !== null) {
        const d = detachAbort;
        detachAbort = null;
        d();
      }
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('Attach aborted before first snapshot'),
      );
    };

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = (): void => signal.removeEventListener('abort', onAbort);
    }

    unsubscribe = emitter.subscribe((event) => {
      if (settled) return;
      switch (event.kind) {
        case 'snapshot':
          settled = true;
          cleanup();
          resolve(event.snapshot);
          return;
        case 'closed':
          settled = true;
          cleanup();
          reject(
            ptyError(
              'pty.session_destroyed',
              `session ${emitter.sessionId} ended before its first snapshot`,
            ),
          );
          return;
        case 'delta':
          // Spec §3.3 forbids deltas before the first snapshot — the
          // pty-host child contract is "synthetic snapshot at ready,
          // THEN deltas". A delta-before-snapshot is a child-side
          // protocol violation; we ignore it here (the steady-state
          // for-await loop will see it) and keep waiting for the
          // snapshot. Logging would belong on the emitter side.
          return;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Bounded buffer for live-event drain (spec §4.4 fast path)
// ---------------------------------------------------------------------------

/**
 * Default capacity of the per-subscriber fallback buffer used on the
 * `requires_ack=false` fast path (spec §4.4). 1024 mirrors the
 * watch-sessions.ts choice — generous for any sane consumer; overflow
 * indicates a stuck reader and terminates the stream with
 * `Code.ResourceExhausted` so the client reconnects.
 *
 * The `requires_ack=true` path uses {@link ACK_CHANNEL_CAPACITY} (4096)
 * via {@link BoundedChannel} from `ack-state.ts` per spec §4.5.
 */
export const ATTACH_FAST_PATH_BUFFER_SIZE = 1024;

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

/**
 * Build the `PtyService.Attach` server-streaming handler.
 *
 * Flow per spec §3-§5:
 *   1. Validate principal is on the context (defensive — same shape as
 *      `makeWatchSessionsHandler` / `makeHelloHandler`).
 *   2. Look up the emitter for `req.sessionId`. NotFound → throw.
 *   3. Resolve the snapshot (if `sinceSeq=0n` and snapshot is null,
 *      `awaitSnapshot` blocks — see §3.3).
 *   4. Run the pure decider over the resume math. Translate refused_*
 *      verdicts to ConnectError.
 *   5. Yield the warm-up frames (snapshot OR replayed deltas).
 *   6. Subscribe for live deltas. Drain into a bounded buffer; yield
 *      each as a `PtyFrame.delta` proto.
 *   7. On AbortSignal fire OR `'closed'` event, terminate cleanly
 *      (cancel) or re-throw `pty.session_destroyed` (closed).
 *
 * `requires_ack=true` (spec §4) uses the {@link BoundedChannel} from
 * ack-state.ts at capacity 4096; overflow throws
 * `pty.subscriber_channel_full`. The full AckPty companion handler
 * (spec §6) is wired in a separate task — this handler only needs to
 * APPLY the per-subscriber backpressure cap, not the per-frame ack
 * watermark.
 */
export function makeAttachHandler(
  deps: PtyAttachDeps,
): ServiceImpl<typeof PtyService>['attach'] {
  return async function* attach(
    req: AttachRequest,
    handlerContext: HandlerContext,
  ): AsyncGenerator<PtyFrame, void, undefined> {
    // Defensive: peerCredAuthInterceptor MUST have deposited the
    // principal before this handler runs. Mirrors hello.ts /
    // watch-sessions.ts posture — surface as Internal so operators see
    // a daemon-side wiring bug rather than the client being told they
    // are unauthenticated.
    const principal = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'PtyService.Attach handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const sessionId = req.sessionId;
    if (sessionId.length === 0) {
      throw ptyError(
        'pty.session_not_found',
        'AttachRequest.session_id MUST be non-empty',
      );
    }

    const emitter = deps.getEmitter(sessionId);
    if (emitter === undefined) {
      throw ptyError(
        'pty.session_not_found',
        `no live pty session with id=${sessionId}`,
        { session_id: sessionId },
      );
    }

    const sinceSeq = req.sinceSeq;
    const signal = handlerContext.signal;

    // §3.3 first-snapshot race window. For `sinceSeq=0n` we MAY need
    // to await the synthetic snapshot before the decider can run (the
    // decider throws on null currentSnapshot in that branch). For any
    // positive sinceSeq the decider doesn't read currentSnapshot, so
    // we skip the await on the deltas-only path.
    let resolvedSnapshot: PtySnapshotInMem | null = emitter.currentSnapshot();
    if (sinceSeq === 0n && resolvedSnapshot === null) {
      resolvedSnapshot = await awaitSnapshot(emitter, signal);
    }

    // §3.4 — pure decider. Snapshot of state is taken right BEFORE we
    // subscribe so the subscribe-then-decide ordering doesn't double-
    // emit a delta that landed between the two reads.
    const verdict: ResumeDecision = decideAttachResume({
      sinceSeq,
      currentMaxSeq: emitter.currentMaxSeq(),
      oldestRetainedSeq: emitter.oldestRetainedSeq(),
      currentSnapshot: resolvedSnapshot,
      deltasSince: (s) => {
        const result = emitter.deltasSince(s);
        if (result === 'out-of-window') {
          // The decider's branch ordering already ruled this out (it
          // checks `sinceSeq < oldestRetainedSeq` first); reaching here
          // means a race between snapshot capture and our read. Fall
          // back to an empty slice — the live subscription picks up
          // the missing window via the next snapshot+delta cadence.
          return [];
        }
        return result;
      },
    });

    switch (verdict.kind) {
      case 'refused_too_far_behind':
        throw ptyError(
          'pty.attach_too_far_behind',
          `since_seq=${verdict.sinceSeq} is older than oldest retained seq=${verdict.oldestRetainedSeq}; ` +
            'reattach with since_seq=0',
          {
            session_id: sessionId,
            since_seq: String(verdict.sinceSeq),
            oldest_retained_seq: String(verdict.oldestRetainedSeq),
          },
        );
      case 'refused_protocol_violation':
        throw ptyError(
          'pty.attach_future_seq',
          `since_seq=${verdict.sinceSeq} exceeds daemon current_max_seq=${verdict.currentMaxSeq}; ` +
            'client lastAppliedSeq accounting bug',
          {
            session_id: sessionId,
            since_seq: String(verdict.sinceSeq),
            current_max_seq: String(verdict.currentMaxSeq),
          },
        );
      case 'snapshot_then_live':
      case 'deltas_only':
        // Fall through to the streaming body below.
        break;
    }

    // §4.2 / §4.4 — pick the buffer primitive based on requires_ack.
    // Both shapes are FIFO; differ only in capacity + the exhaustion
    // error code (§4.3).
    const requiresAck = req.requiresAck === true;
    const channelCapacity = requiresAck
      ? ACK_CHANNEL_CAPACITY
      : ATTACH_FAST_PATH_BUFFER_SIZE;
    const channel = new BoundedChannel<DeltaInMem>(channelCapacity);
    const overflowErrorCode: PtyAttachErrorCode = requiresAck
      ? 'pty.subscriber_channel_full'
      : 'pty.subscriber_channel_full';

    // §4.2 / §6 — Task #49 / T4.13: per-subscriber ack-state. Constructed
    // ONLY for `requires_ack=true` Attach streams. Registered under
    // (principalKey, sessionId) so the AckPty companion handler can
    // look it up by the same tuple (spec §6.1). The `requires_ack=false`
    // fast path skips this entirely — AckPty for those subscribers is a
    // no-op OK reply per §6.2 (covered by `findFirstAckSubscriber`
    // returning undefined).
    //
    // `lastDeliveredSeq` advances via `subscriber.onDelivered(seq)` after
    // every delta this generator yields onto the wire (both warm-up and
    // steady-state). `lastAckedSeq` advances via the AckPty handler.
    // `unackedBacklog = lastDeliveredSeq - lastAckedSeq` is the spec §4.3
    // watchdog input; the producer-side overflow guard (channel.size at
    // capacity) fires first in normal operation, but `unackedBacklog` is
    // the load-bearing value AckPty queries on every tick.
    const principalCanonicalKey = toPrincipalKey(principal);
    const ackSubscriber: AckSubscriberState | null = requiresAck
      ? new AckSubscriberState({
          subscriberId: randomUUID(),
          sessionId,
          initialSeq: sinceSeq,
          channelCapacity: ACK_CHANNEL_CAPACITY,
        })
      : null;
    if (ackSubscriber !== null) {
      registerAckSubscriber(principalCanonicalKey, ackSubscriber);
    }

    // Producer→consumer rendezvous primitive. The emitter listener
    // resolves a pending `next()`; if no consumer is waiting it appends
    // to the channel. Mirrors the watch-sessions.ts adapter shape
    // (single-slot promise queue) but threaded through the
    // BoundedChannel so the consumer can drain in FIFO order.
    let pendingResolve: ((event: PtyEmitterEvent | null) => void) | null = null;
    const eventQueue: PtyEmitterEvent[] = [];
    type ClosedReason =
      | { readonly kind: 'aborted' }
      | { readonly kind: 'session-destroyed' }
      | { readonly kind: 'overflow' };
    let closedReason: ClosedReason | null = null;

    const wakeConsumer = (event: PtyEmitterEvent | null): void => {
      if (pendingResolve !== null) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(event);
        return;
      }
      if (event !== null) {
        eventQueue.push(event);
      }
    };

    const listener: PtyEmitterListener = (event) => {
      if (closedReason !== null) {
        // Already terminating — drop further events. The unsubscribe
        // either ran already or will run shortly.
        return;
      }
      if (event.kind === 'delta') {
        const result = channel.enqueue(event.delta);
        if (result === 'overflow') {
          closedReason = { kind: 'overflow' } satisfies ClosedReason;
          wakeConsumer(null);
          return;
        }
      }
      // Always wake the consumer — the consumer drains via channel for
      // deltas and via the event itself for snapshot/closed.
      wakeConsumer(event);
    };

    const unsubscribe = emitter.subscribe(listener);

    // §5 — abort signal forwarding. Connect-ES fires the signal on
    // client disconnect, server shutdown, or listener rotation. We
    // detach the listener AND wake any pending consumer so the
    // for-await loop exits cleanly.
    const onAbort = (): void => {
      if (closedReason !== null) return;
      closedReason = { kind: 'aborted' } satisfies ClosedReason;
      wakeConsumer(null);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const detachAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    try {
      // ---- Warm-up frames ----------------------------------------
      if (verdict.kind === 'snapshot_then_live') {
        yield snapshotToFrame(verdict.snapshot);
      } else {
        // deltas_only — replay the (sinceSeq, currentMaxSeq] slice.
        for (const delta of verdict.deltas) {
          // §4.2 onDelivered BEFORE the yield: at the moment the
          // generator surrenders the frame to the Connect transport
          // it is committed to deliver — even if the client cancels
          // mid-await, no later delta is ever sent. Bumping the
          // watermark first means an AckPty arriving in the same tick
          // (e.g. the renderer pipelines acks aggressively) sees a
          // consistent (lastDeliveredSeq, lastAckedSeq) snapshot and
          // does not spuriously trip §6.1 ack_overrun.
          if (ackSubscriber !== null) {
            ackSubscriber.onDelivered(delta.seq);
          }
          yield deltaToFrame(delta);
        }
      }

      // ---- Steady-state drain -----------------------------------
      // Loop invariant: after each pass either we yield a frame, we
      // throw a terminal error, or we return cleanly (signal aborted).
      // The bounded channel may already contain entries that the
      // listener queued between subscribe() and the first await — drain
      // those FIRST before parking on a new resolver.
      while (true) {
        // 1) Drain any deltas the listener buffered.
        while (true) {
          const delta = channel.dequeue();
          if (delta === undefined) break;
          if (ackSubscriber !== null) {
            ackSubscriber.onDelivered(delta.seq);
          }
          yield deltaToFrame(delta);
        }

        // 2) If a terminal condition fired during the drain, react now.
        // (Cast through ClosedReason — TS narrows `closedReason` to the
        // 'session-destroyed' variant when looking at this generator
        // body in isolation because the 'aborted' / 'overflow'
        // assignments live inside the listener / onAbort closures.
        // The runtime variable is the full union; the cast restores
        // the type the variable was declared with.)
        if (closedReason !== null) {
          const reason = closedReason as ClosedReason;
          switch (reason.kind) {
            case 'aborted':
              return; // clean cancel — Connect surfaces as canceled
            case 'session-destroyed':
              throw ptyError(
                'pty.session_destroyed',
                `session ${sessionId} was destroyed`,
                { session_id: sessionId },
              );
            case 'overflow':
              throw ptyError(
                overflowErrorCode,
                requiresAck
                  ? `subscriber channel full (>= ${ACK_CHANNEL_CAPACITY} unacked deltas); ` +
                      `reconnect with since_seq = lastAckedSeq`
                  : `subscriber channel full (>= ${ATTACH_FAST_PATH_BUFFER_SIZE} buffered deltas); ` +
                      `consumer too slow — reconnect`,
                { session_id: sessionId },
              );
            default: {
              const _exhaustive: never = reason;
              throw new Error(
                `unhandled closedReason: ${String((_exhaustive as { kind: string }).kind)}`,
              );
            }
          }
        }

        // 3) Process any non-delta events the listener queued.
        //    - 'session-state-changed': yield as PtyFrame.session_state_changed
        //      (spec ch06 §4 — out-of-band signal, additive PtyFrame oneof).
        //    - 'closed': set closedReason; next pass surfaces the terminal
        //      error per §7.2.
        //    - 'snapshot': dropped per §2.4 ("at-most-one snapshot per Attach").
        //    - 'delta': already enqueued into the channel by the listener.
        while (eventQueue.length > 0) {
          const ev = eventQueue.shift() as PtyEmitterEvent;
          if (ev.kind === 'closed') {
            closedReason = { kind: 'session-destroyed' } satisfies ClosedReason;
          } else if (ev.kind === 'session-state-changed') {
            yield sessionStateChangedToFrame(ev);
          }
          // 'snapshot' and 'delta' (already enqueued above) — drop.
        }
        if (closedReason !== null) {
          continue; // re-evaluate the terminal-conditions block
        }

        // 4) Park on the next event. The listener resolves with `null`
        //    on overflow / abort (terminal) or with the event for
        //    snapshot/closed/delta/session-state-changed (non-null).
        const nextEvent = await new Promise<PtyEmitterEvent | null>(
          (resolve) => {
            pendingResolve = resolve;
          },
        );
        if (nextEvent === null) {
          // Wake by overflow or abort — re-evaluate at top of loop.
          continue;
        }
        if (nextEvent.kind === 'closed') {
          closedReason = { kind: 'session-destroyed' } satisfies ClosedReason;
          continue;
        }
        if (nextEvent.kind === 'snapshot') {
          // Steady-state Attach IGNORES mid-stream snapshots per §2.4.
          continue;
        }
        if (nextEvent.kind === 'session-state-changed') {
          // Out-of-band SessionState transition (spec ch06 §4). Yield
          // immediately as PtyFrame.session_state_changed; the next loop
          // iteration's drain step will continue with any deltas the
          // listener queued in the meantime.
          yield sessionStateChangedToFrame(nextEvent);
          continue;
        }
        // nextEvent.kind === 'delta': it was already enqueued by the
        // listener; the next loop iteration's drain step yields it.
      }
    } finally {
      detachAbort();
      unsubscribe();
      channel.clear();
      // Task #49 / T4.13: drop the per-subscriber ack-state from the
      // (principalKey, sessionId) registry so a late AckPty RPC for this
      // closed stream falls through to the spec §6.2 no-op path. Safe to
      // call when ackSubscriber is null (requires_ack=false fast path).
      if (ackSubscriber !== null) {
        unregisterAckSubscriber(principalCanonicalKey, ackSubscriber);
      }
      // Wake any straggler resolver so a Promise we're not awaiting
      // does not pin GC. (Defensive — by construction we never `await`
      // after entering `finally`.)
      if (pendingResolve !== null) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(null);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// AckPty companion handler — Task #49 / T4.13 (spec §6).
// ---------------------------------------------------------------------------

/**
 * Build the `PtyService.AckPty` unary handler. Spec
 * `2026-05-04-pty-attach-handler.md` §6.
 *
 * Lookup is by `(principalKey(principal), session_id)` against the
 * module-level subscriber registry that the Attach handler populates on
 * `requires_ack=true` streams. When no subscriber is registered (the
 * three §6.2 cases — `requires_ack=false`, post-disconnect race,
 * out-of-order client) the handler returns OK with
 * `daemon_max_seq = emitter.currentMaxSeq` and does NOT touch any state.
 *
 * Validation failures (`pty.ack_overrun`, `pty.ack_regress`) become
 * `Code.InvalidArgument` ConnectError responses with the same
 * forever-stable error code strings the renderer instruments on. The
 * pure decider lives on {@link AckSubscriberState.onAck}; this handler
 * is the (sink) wire boundary that converts the decider verdict to
 * Connect responses.
 */
export function makeAckPtyHandler(
  deps: PtyAttachDeps,
): ServiceImpl<typeof PtyService>['ackPty'] {
  return async function ackPty(
    req: AckPtyRequest,
    handlerContext: HandlerContext,
  ): Promise<AckPtyResponse> {
    // Defensive: peerCredAuthInterceptor MUST have run. Mirrors the
    // posture in `attach` above + hello.ts / watch-sessions.ts.
    const principal = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'PtyService.AckPty handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const sessionId = req.sessionId;
    if (sessionId.length === 0) {
      throw ptyError(
        'pty.session_not_found',
        'AckPtyRequest.session_id MUST be non-empty',
      );
    }

    // §6.1 lookup: (principalKey, sessionId) → first matching ack
    // subscriber. The emitter is consulted in BOTH §6.1 (advance
    // watermark + return daemon_max_seq) and §6.2 (no-op return
    // daemon_max_seq) so we resolve it up front.
    const emitter = deps.getEmitter(sessionId);
    if (emitter === undefined) {
      // Spec §6.2 covers the "no live subscriber" case as a no-op OK,
      // BUT a totally unknown session id is distinct from "session
      // exists, no ack subscriber on this principal". The Attach
      // handler maps unknown id to NotFound; mirroring that here keeps
      // the two RPCs symmetric for the typo case while still allowing
      // §6.2 no-op behavior when the session exists but the calling
      // principal has no live `requires_ack=true` Attach.
      throw ptyError(
        'pty.session_not_found',
        `no live pty session with id=${sessionId}`,
        { session_id: sessionId },
      );
    }

    const subscriber = findFirstAckSubscriber(
      toPrincipalKey(principal),
      sessionId,
    );

    if (subscriber === undefined) {
      // §6.2 — no-op OK reply. Covers requires_ack=false subscriber,
      // post-disconnect race, and out-of-order AckPty (RPC arrives
      // before the matching Attach). All three return the same shape:
      // OK with daemon_max_seq and no state mutation.
      return create(AckPtyResponseSchema, {
        meta: create(RequestMetaSchema, {}),
        daemonMaxSeq: emitter.currentMaxSeq(),
      });
    }

    // §6.1 — validated ack on a live `requires_ack=true` subscriber.
    const verdict = subscriber.onAck(req.appliedSeq);
    if (verdict.kind === 'rejected') {
      throw ptyError(
        verdict.reason,
        verdict.reason === 'pty.ack_overrun'
          ? `applied_seq=${verdict.appliedSeq} exceeds last_delivered_seq=${verdict.lastDeliveredSeq}; ` +
              'client cannot ack a frame the daemon never sent'
          : `applied_seq=${verdict.appliedSeq} regresses below last_acked_seq=${verdict.lastAckedSeq}; ` +
              'acks must be monotonically non-decreasing',
        {
          session_id: sessionId,
          applied_seq: String(verdict.appliedSeq),
          last_delivered_seq: String(verdict.lastDeliveredSeq),
          last_acked_seq: String(verdict.lastAckedSeq),
        },
      );
    }

    return create(AckPtyResponseSchema, {
      meta: create(RequestMetaSchema, {}),
      daemonMaxSeq: emitter.currentMaxSeq(),
    });
  };
}
