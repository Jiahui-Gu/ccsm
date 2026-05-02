// Connect server-stream handler for `ccsm.v1.CcsmService.SubscribeSessionEvents`
// (daemon-side, Task #106 v0.3 "SessionWatcher 搬 daemon").
//
// Proto-agnostic core: this module owns the per-stream snapshot+delta
// orchestration in POJO form (shapes from `./sessionState.ts`). The
// proto-aware shim that converts to typed proto messages and registers
// against the Connect router lives at the wiring boundary
// (`daemon/src/connect/sessionWatcherRoutes.ts`). Splitting them keeps
// the busy state-machine code testable without spinning up a Connect
// transport.
//
// Per-stream flow:
//
//   1. Accept the request's `(sessionId, fromSeq, fromBootNonce, heartbeatMs)`.
//   2. Compare `fromBootNonce` with the daemon's current `bootNonce`.
//      Mismatch → emit `boot_changed` then snapshot from seq 0 (frag-
//      3.5.1 §3.5.1.4 fwdcompat-P1-1).
//   3. Otherwise: if `fromSeq <= 0` → emit fresh snapshot (gap=false).
//      If `fromSeq > 0` → no snapshot, server only delivers deltas
//      with `seq > fromSeq` from now on. Replay budget for back-fill
//      is owned by the wiring shim (this PR ships the snapshot-on-
//      stale path; replay-from-history needs the daemon SQLite event
//      log from #105 — until then `fromSeq > 0 + same bootNonce` falls
//      through to "snapshot with gap=true" which the renderer handles
//      identically).
//   4. Subscribe to the registry (filter = sessionId). Every incoming
//      `SessionEventPojo` is forwarded to the stream's `push` callback.
//   5. Schedule a heartbeat timer at `heartbeatMs` cadence (default
//      15_000 ms; clamped to [1_000, 60_000]). The state machine's
//      `emitHeartbeat` routes through the SAME `emit` callback the
//      registry consumes, so heartbeats also reach this subscriber via
//      the broadcast path.
//   6. Caller cancel / daemon shutdown / session removal closes the
//      stream cleanly via the registry's `close(reason)` callback.

import type { SessionStateMachine, SessionEventPojo, SessionSnapshotEventPojo } from './sessionState.js';
import type {
  SessionDrainReason,
  SessionSubscriber,
  SessionSubscriberRegistry,
} from './subscriberRegistry.js';

// ---------------------------------------------------------------------------
// Wire request / response shapes (POJO mirror of proto)
// ---------------------------------------------------------------------------

export interface SubscribeRequestPojo {
  /** Empty string ⇒ firehose (every session). */
  sessionId: string;
  fromSeq: number;
  fromBootNonce: string;
  heartbeatMs: number;
}

export interface SubscribeStream {
  /** Push one event to the caller. Transport is responsible for proto
   *  serialization (this module ships POJO; the route shim wraps in
   *  the typed proto message). */
  push(evt: SessionEventPojo): void;
  /** End the stream cleanly. Idempotent: subsequent calls are no-ops.
   *  Reason maps to a Connect-level status code in the wiring shim
   *  (caller-cancel → CANCELED; session-removed → NOT_FOUND;
   *  daemon-shutdown → UNAVAILABLE). */
  end(reason: SubscribeEndReason): void;
}

export type SubscribeEndReason =
  | { kind: 'caller-cancel' }
  | { kind: 'session-removed'; sessionId: string }
  | { kind: 'daemon-shutdown' }
  | { kind: 'invalid-request'; detail: string };

export interface SubscribeContext {
  readonly stateMachine: SessionStateMachine;
  readonly registry: SessionSubscriberRegistry;
  /** Daemon-current bootNonce. Compared against the request's
   *  `fromBootNonce` to decide snapshot-replay vs `boot_changed`. */
  readonly bootNonce: string;
  /** Test seam for the heartbeat timer. Defaults to `setInterval` /
   *  `clearInterval`. */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly log?: {
    debug?: (obj: Record<string, unknown>, msg: string) => void;
  };
}

const HEARTBEAT_MS_DEFAULT = 15_000;
const HEARTBEAT_MS_MIN = 1_000;
const HEARTBEAT_MS_MAX = 60_000;

function clampHeartbeat(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return HEARTBEAT_MS_DEFAULT;
  if (ms < HEARTBEAT_MS_MIN) return HEARTBEAT_MS_MIN;
  if (ms > HEARTBEAT_MS_MAX) return HEARTBEAT_MS_MAX;
  return ms;
}

/**
 * Build a `SessionSnapshotEventPojo` for one session id. Returns null
 * if the session doesn't exist. Used both at subscribe-time and on
 * `boot_changed` re-snapshot.
 */
export function buildSnapshotEvent(
  ctx: SubscribeContext,
  sessionId: string,
  gap: boolean,
): SessionSnapshotEventPojo | null {
  const snapshot = ctx.stateMachine.getSnapshot(sessionId);
  if (!snapshot) return null;
  return {
    kind: 'snapshot',
    snapshot,
    tsMs: Date.now(),
    gap,
  };
}

/**
 * Handle one `SubscribeSessionEvents` server-stream RPC. Returns the
 * cancel hook the transport invokes when the caller disconnects.
 */
export function handleSubscribeSessionEvents(
  req: SubscribeRequestPojo,
  stream: SubscribeStream,
  ctx: SubscribeContext,
): () => void {
  const setIntervalFn =
    ctx.setInterval ?? ((fn, ms) => setInterval(fn, ms) as unknown);
  const clearIntervalFn =
    ctx.clearInterval ??
    ((handle): void => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  // Forward-declared so endOnce (which may run during the validate-and-
  // bail-early paths below, before subscribe / setInterval have happened)
  // doesn't trip the TDZ on its first reference.
  let unsubscribe: (() => void) | null = null;
  let heartbeatHandle: unknown | null = null;

  // Single-end guard.
  let ended = false;
  const endOnce = (reason: SubscribeEndReason): void => {
    if (ended) return;
    ended = true;
    if (heartbeatHandle !== null) {
      clearIntervalFn(heartbeatHandle);
      heartbeatHandle = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    try {
      stream.end(reason);
    } catch (err) {
      ctx.log?.debug?.(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: req.sessionId,
          reason,
        },
        'subscribe_end_threw',
      );
    }
  };

  // Validate request (defensive — proto schema enforces shape, but the
  // POJO boundary is where untyped data could have slipped in).
  if (typeof req.sessionId !== 'string') {
    endOnce({ kind: 'invalid-request', detail: 'sessionId must be a string' });
    return () => {
      /* nothing to clean up */
    };
  }
  if (req.sessionId !== '' && !ctx.stateMachine.hasSession(req.sessionId)) {
    // For per-session subscribes, an unknown sessionId ends with
    // session-removed (caller is asked to retry on next list). For
    // firehose ("") we accept and stream nothing until a session
    // appears.
    endOnce({ kind: 'session-removed', sessionId: req.sessionId });
    return () => {
      /* nothing to clean up */
    };
  }

  const heartbeatMs = clampHeartbeat(req.heartbeatMs);

  // Step 2 + 3: bootNonce mismatch → boot_changed + snapshot.
  // Same-nonce + fromSeq <= 0 → fresh snapshot (gap=false).
  // Same-nonce + fromSeq > 0 → snapshot with gap=true (history replay
  //   not yet implemented — the SQLite event log lands in #105).
  const bootMismatch =
    req.fromBootNonce !== '' && req.fromBootNonce !== ctx.bootNonce;
  // Three cases (per the comment block above): bootMismatch → snapshot
  // (gap=false, after boot_changed); same-nonce + fromSeq<=0 → snapshot
  // (gap=false); same-nonce + fromSeq>0 → snapshot (gap=true) until #105
  // lands the SQLite event-log replay path. All three want a snapshot.
  const wantSnapshot = true;
  const gap = !bootMismatch && req.fromSeq > 0;

  if (req.sessionId !== '') {
    if (bootMismatch) {
      try {
        stream.push({
          kind: 'boot_changed',
          sessionId: req.sessionId,
          bootNonce: ctx.bootNonce,
          snapshotPending: true,
        });
      } catch (err) {
        ctx.log?.debug?.(
          { err: err instanceof Error ? err.message : String(err) },
          'subscribe_push_boot_changed_threw',
        );
      }
    }
    if (wantSnapshot) {
      const snap = buildSnapshotEvent(ctx, req.sessionId, gap);
      if (snap !== null) {
        try {
          stream.push(snap);
        } catch (err) {
          ctx.log?.debug?.(
            { err: err instanceof Error ? err.message : String(err) },
            'subscribe_push_snapshot_threw',
          );
        }
      }
    }
  } else {
    // Firehose subscribe: emit a snapshot for every currently-known
    // session so the new subscriber starts from the latest known state.
    if (wantSnapshot) {
      for (const sid of ctx.stateMachine.sessionIds()) {
        const snap = buildSnapshotEvent(ctx, sid, gap);
        if (snap === null) continue;
        try {
          stream.push(snap);
        } catch (err) {
          ctx.log?.debug?.(
            { err: err instanceof Error ? err.message : String(err) },
            'subscribe_push_firehose_snapshot_threw',
          );
        }
      }
    }
  }

  // Step 4: live subscription.
  const subscriber: SessionSubscriber = {
    deliver(evt) {
      try {
        stream.push(evt);
      } catch (err) {
        ctx.log?.debug?.(
          {
            err: err instanceof Error ? err.message : String(err),
            sessionId: req.sessionId,
            evtKind: evt.kind,
          },
          'subscribe_push_threw',
        );
      }
    },
    close(reason: SessionDrainReason) {
      switch (reason.kind) {
        case 'session-removed':
          endOnce({ kind: 'session-removed', sessionId: reason.sessionId });
          return;
        case 'daemon-shutdown':
          endOnce({ kind: 'daemon-shutdown' });
          return;
        case 'caller-cancel':
          endOnce({ kind: 'caller-cancel' });
          return;
      }
    },
  };
  unsubscribe = ctx.registry.subscribe(
    req.sessionId,
    subscriber,
  );

  // Step 5: heartbeat timer.
  heartbeatHandle = setIntervalFn(() => {
    // Heartbeats target only the per-session subscribe path; firehose
    // subscribers receive heartbeats via every per-session emit.
    if (req.sessionId === '') return;
    ctx.stateMachine.emitHeartbeat(req.sessionId);
  }, heartbeatMs);

  ctx.log?.debug?.(
    {
      sessionId: req.sessionId,
      fromSeq: req.fromSeq,
      bootMismatch,
      heartbeatMs,
    },
    'subscribe_session_events_attached',
  );

  // Step 6: cancel hook.
  return () => {
    endOnce({ kind: 'caller-cancel' });
  };
}
