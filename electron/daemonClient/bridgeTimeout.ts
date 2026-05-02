// electron/daemonClient/bridgeTimeout.ts
//
// Bridge call deadline primitives for the Electron-side Connect-Node client
// (Task #103, frag-3.5.1 §3.5.1.3 lock).
//
// Three exports — each owns one concern:
//
//   1. `BridgeTimeoutError`           — typed error thrown by the bridge layer
//                                       on per-call deadline expiry. NEVER
//                                       user-surfaced (see frag-3.5.1 §3.5.1.3
//                                       round-3 lock + §3.7.4 toast UX): the
//                                       bridge retries once internally and
//                                       then flips the surface-registry
//                                       'reconnecting' slot.
//
//   2. `anyAbortSignal(signals)`      — Node 20+ `AbortSignal.any` polyfill /
//                                       ponyfill. Node 20.3+ ships it natively;
//                                       we feature-detect and fall back to a
//                                       hand-rolled merge so the bridge runs
//                                       on Electron's bundled Node which may
//                                       lag the upstream release. The merged
//                                       signal aborts on the first input that
//                                       aborts, with the original `reason`.
//
//   3. `createTimeoutMap()`           — per-call deadline tracker keyed by an
//                                       opaque call-id (ULID/string). The
//                                       bridge inserts an entry when issuing
//                                       a call, deletes it on resolve/reject,
//                                       and queries `leakedSince(thresholdMs)`
//                                       at supervisor scrape time to populate
//                                       the `handler.leaked.count` counter
//                                       (§3.5.1.3 — handler kept running
//                                       after AbortSignal aborted).
//
// Single Responsibility breakdown (per dev contract §2):
//   - DECIDER: `BridgeTimeoutError` is a passive value class. `anyAbortSignal`
//     is pure (no I/O). `timeoutMap.leakedSince` is a pure read.
//   - PRODUCER / SINK: timeoutMap mutation (`startCall` / `endCall`) is the
//     bridge's bookkeeping; no external I/O lives here.
//
// Spec citations (see also `connectClient.ts` for transport semantics):
//   - frag-3.5.1 §3.5.1.3 (Bridge call timeout + AbortSignal threading) — the
//     `AbortSignal.any([userSignal, AbortSignal.timeout(timeoutMs)])` pattern,
//     the `BridgeTimeoutError { code, method, timeoutMs, traceId }` shape,
//     and the `handler.leaked.count` counter contract.
//   - frag-3.5.1 §3.5.1.3 round-3 r3-devx lock — `BridgeTimeoutError` is
//     internal to the bridge; the renderer never sees it.

// ---------------------------------------------------------------------------
// 1. BridgeTimeoutError
// ---------------------------------------------------------------------------

/**
 * Bridge-layer deadline error. Thrown by `connectClient.call(...)` when the
 * per-call timeout expires before the daemon replies. The renderer MUST NOT
 * see this — the bridge layer catches it, retries once, then flips the
 * surface-registry 'reconnecting' slot (frag-6-7 §6.8) and rejects the
 * original promise with a generic disconnect surface.
 *
 * Field meanings:
 *   - `code`      : always `'DEADLINE_EXCEEDED'` (gRPC convention; matches
 *                   the daemon-side Connect `Code.DeadlineExceeded` mapping
 *                   so log greps cross daemon/electron with one term).
 *   - `method`    : RPC method name (Connect `MethodInfo.name` — the proto
 *                   field, NOT the URL path).
 *   - `timeoutMs` : the deadline that fired. Useful for log triage when a
 *                   per-method override map (Task 5) sets a non-default cap.
 *   - `traceId`   : ULID of the originating call so a renderer log line can
 *                   be correlated with the daemon-side handler trace. May be
 *                   `undefined` if the call was issued without a trace-id
 *                   header (e.g. boot-time `Ping`).
 */
export class BridgeTimeoutError extends Error {
  public readonly code = 'DEADLINE_EXCEEDED' as const;
  public readonly method: string;
  public readonly timeoutMs: number;
  public readonly traceId: string | undefined;

  constructor(opts: { method: string; timeoutMs: number; traceId?: string | undefined }) {
    super(
      `bridge call ${opts.method} exceeded ${opts.timeoutMs}ms deadline` +
        (opts.traceId !== undefined ? ` (traceId=${opts.traceId})` : ''),
    );
    this.name = 'BridgeTimeoutError';
    this.method = opts.method;
    this.timeoutMs = opts.timeoutMs;
    this.traceId = opts.traceId;
  }
}

/** Type predicate so callers can branch without `instanceof` import.
 *
 * NOTE: `instanceof` is the load-bearing check; the predicate exists only
 * for ergonomic narrowing (`if (isBridgeTimeoutError(e)) e.timeoutMs`). */
export function isBridgeTimeoutError(e: unknown): e is BridgeTimeoutError {
  return e instanceof BridgeTimeoutError;
}

// ---------------------------------------------------------------------------
// 2. anyAbortSignal — AbortSignal.any ponyfill
// ---------------------------------------------------------------------------

/**
 * Merge zero or more AbortSignals into a single signal that aborts on the
 * first input abort, with that input's `reason`.
 *
 * Implementation strategy:
 *   - If `AbortSignal.any` exists at runtime (Node 20.3+), defer to it. We
 *     feature-detect rather than version-test because Electron's bundled
 *     Node is occasionally pinned behind upstream and a feature-test is
 *     forward-compatible (no version table to keep up to date).
 *   - Otherwise, build a fresh `AbortController`, walk inputs:
 *       * if any is already aborted → abort immediately with its reason
 *       * else attach a one-shot listener per input that aborts the
 *         controller with its reason on first abort.
 *     We deliberately do NOT clean listeners on the OTHER inputs after one
 *     fires — they stay attached until their underlying signal is GC'd.
 *     Each listener is `{ once: true }` so it only fires once; the cost of
 *     a stale "no-op" listener until GC is much cheaper than tracking N
 *     remove handles per merged signal (mirrors the Node std-lib impl).
 *
 * Edge cases:
 *   - Empty input → returns a never-aborting signal (matches Node's
 *     spec for `AbortSignal.any([])`).
 *   - Single input → returns it verbatim (trivial fast path; sidesteps a
 *     redundant controller allocation per call).
 */
export function anyAbortSignal(signals: readonly AbortSignal[]): AbortSignal {
  // Fast paths.
  if (signals.length === 0) {
    return new AbortController().signal;
  }
  if (signals.length === 1) {
    // Definite assignment: length === 1 guarantees signals[0] exists.
    // noUncheckedIndexedAccess narrows it as `AbortSignal | undefined`,
    // hence the explicit non-null read into a local.
    const only = signals[0];
    if (only !== undefined) return only;
  }

  // Native fast path (Node 20.3+). Cast through unknown because @types/node
  // in older Electron toolchains may not declare AbortSignal.any yet.
  const native = (AbortSignal as unknown as {
    any?: (input: readonly AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof native === 'function') {
    return native(signals);
  }

  // Manual merge.
  const controller = new AbortController();
  // If any input is already aborted, bail immediately. Walk in declared
  // order so the reported `reason` is deterministic across runs (matches
  // the spec for AbortSignal.any).
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
  }
  for (const s of signals) {
    s.addEventListener(
      'abort',
      () => {
        if (!controller.signal.aborted) {
          controller.abort(s.reason);
        }
      },
      { once: true },
    );
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// 3. timeout map — per-call deadline tracker
// ---------------------------------------------------------------------------

/** Snapshot of a single in-flight call. Returned by `timeoutMap.entries()`
 *  for tests / supervisor scrape; the bridge does not consume this shape
 *  directly. */
export interface TimeoutMapEntry {
  readonly callId: string;
  readonly method: string;
  readonly timeoutMs: number;
  /** Wall-clock ms (`Date.now()`-style) at which the deadline was scheduled
   *  to fire. */
  readonly deadlineAt: number;
  /** Wall-clock ms at which the deadline DID fire and the bridge aborted
   *  the call. `undefined` if the call is still pre-deadline. */
  readonly firedAt: number | undefined;
}

export interface TimeoutMap {
  /** Mark a call started. The bridge calls this just before issuing the
   *  Connect promise. */
  startCall(opts: { callId: string; method: string; timeoutMs: number; now?: number }): void;
  /** Mark the deadline as having fired. The bridge calls this from the
   *  per-call timer callback (or the merged AbortSignal listener) so the
   *  entry transitions to "leaked candidate" — if `endCall` lands later
   *  than `thresholdMs` after `firedAt`, the call leaked. */
  markFired(callId: string, now?: number): void;
  /** Mark a call resolved/rejected. Always safe to call (idempotent). */
  endCall(callId: string): void;
  /** Count entries that fired the deadline AT LEAST `thresholdMs` ago AND
   *  are still in the map (i.e. handler kept running long after abort).
   *  This is the supervisor's `handler.leaked.count` source. */
  leakedSince(thresholdMs: number, now?: number): number;
  /** Returns the in-flight call count (pre-deadline + post-deadline). */
  size(): number;
  /** Snapshot for tests / debug overlays. Order is insertion. */
  entries(): readonly TimeoutMapEntry[];
}

/**
 * Build a fresh timeout map. Stateless across instances so tests can spin
 * one per case without WeakMap-style sharing.
 *
 * Implementation note: a plain `Map<string, MutableEntry>` is sufficient.
 * We don't need an LRU because the bridge ALWAYS calls `endCall` (in a
 * `finally` block); the map size is bounded by the in-flight call count,
 * which Connect itself bounds via per-stream concurrency.
 */
export function createTimeoutMap(): TimeoutMap {
  interface MutableEntry {
    callId: string;
    method: string;
    timeoutMs: number;
    deadlineAt: number;
    firedAt: number | undefined;
  }
  const m = new Map<string, MutableEntry>();
  return {
    startCall({ callId, method, timeoutMs, now }) {
      const t = now ?? Date.now();
      m.set(callId, {
        callId,
        method,
        timeoutMs,
        deadlineAt: t + timeoutMs,
        firedAt: undefined,
      });
    },
    markFired(callId, now) {
      const e = m.get(callId);
      if (!e) return;
      if (e.firedAt === undefined) {
        e.firedAt = now ?? Date.now();
      }
    },
    endCall(callId) {
      m.delete(callId);
    },
    leakedSince(thresholdMs, now) {
      const t = now ?? Date.now();
      let n = 0;
      for (const e of m.values()) {
        if (e.firedAt !== undefined && t - e.firedAt >= thresholdMs) {
          n += 1;
        }
      }
      return n;
    },
    size() {
      return m.size;
    },
    entries() {
      return Array.from(m.values()).map((e) => ({
        callId: e.callId,
        method: e.method,
        timeoutMs: e.timeoutMs,
        deadlineAt: e.deadlineAt,
        firedAt: e.firedAt,
      }));
    },
  };
}
