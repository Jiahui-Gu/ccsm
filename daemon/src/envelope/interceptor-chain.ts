// Envelope interceptor chain wiring (#153 N13-fix).
//
// Composes the 5 envelope-side deciders shipped by #809 (trace + metrics) and
// the earlier T7..T10 wave (helloInterceptor, deadlineInterceptor,
// migrationGateInterceptor) into a single `dispatchWithInterceptors()` entry
// point that the envelope adapter (daemon/src/envelope/adapter.ts) calls in
// place of `dispatcher.dispatch()` directly.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.f built-in interceptor pipeline (canonical order, no manager
//     escape hatch — chain order is part of the wire contract).
//   - PR #809 (Task #129) shipped trace + metrics interceptor MODULES but did
//     NOT wire them into the dispatch path. This module is that wiring.
//   - frag-6-7 §6.5 supervisor envelope is the v0.4 control plane → wiring
//     here is permanent (zero-rework rule).
//
// Spec-locked chain order (outermost → innermost; each slot may be a no-op
// when its dependency is omitted):
//
//     [0] hello       — pre-handshake gate (rejects with `hello_required`)
//     [1] trace       — open span, mint daemonTraceId, log on completion
//     [2] deadline    — read x-ccsm-deadline-ms, clamp into [100ms .. 120s]
//     [3] migrationGate — block data-plane during SQLite migration
//     [4] dispatcher  — route to handler (see daemon/src/dispatcher.ts)
//     [5] metrics     — recordRequest / recordError / recordDuration
//
// Slot #5 lives at the OUTSIDE of the dispatcher call site (we wrap the
// dispatch result rather than threading metrics through every interceptor)
// because the metrics registry is a sink not a decider — it observes
// outcomes, never modifies them.
//
// Single Responsibility: this module is the WIRING. It owns ZERO state
// itself (handshake state, migration flag, metrics registry, trace clock are
// all injected). It does NOT own a logger instance — the trace sink is
// caller-supplied. It does NOT own a socket. The reply payload it returns is
// consumed by the envelope adapter, which serialises it to wire bytes.

import { Buffer } from 'node:buffer';

import type { DispatchContext, Dispatcher, DispatchResult } from '../dispatcher.js';
import { applyDeadline, DEADLINE_HEADER } from './deadline-interceptor.js';
import {
  decideHello,
  type HelloConnectionState,
  type HelloInterceptorConfig,
  type HelloReplyPayload,
} from './hello-interceptor.js';
import type { MetricsRegistry } from './metrics-interceptor.js';
import { checkMigrationGate } from './migration-gate-interceptor.js';
import {
  DAEMON_TRACE_ID_HEADER,
  defaultMintTraceId,
  formatCompletionLog,
  resolveTraceId,
  startTrace,
  type ClockMs,
  type TraceLogSink,
} from './trace-interceptor.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Per-envelope inputs from the adapter. Mirrors the subset of envelope-header
 * fields the chain inspects; the adapter forwards the full envelope to
 * dispatched handlers untouched (this shape is decider-only).
 */
export interface EnvelopeRequest {
  /** RPC id; echoed in the reply. */
  readonly id: number;
  /** Wire-literal RPC method name (literal compare per §3.4.1.h carve-out lock). */
  readonly method: string;
  /** Optional client-supplied trace id (Crockford ULID; opaque on the daemon side). */
  readonly traceId?: string;
  /** Inbound envelope headers (lower-cased keys). The deadline interceptor
   *  reads `x-ccsm-deadline-ms`; future header-policy interceptors slot in
   *  here without churning the call site. */
  readonly headers?: Record<string, string | number>;
  /**
   * Parsed payload (JSON-frame mode) or `{ ...header, payload: Buffer }`
   * (binary-frame mode). The hello interceptor inspects this on
   * `method === HELLO_METHOD`; for all other methods this is forwarded
   * opaquely to the dispatcher / handler.
   */
  readonly payload?: unknown;
}

/**
 * Per-connection state injected by the adapter. The hello interceptor mutates
 * `helloState` in-place on a successful first hello (single-source-of-truth
 * mutation site, see hello-interceptor.ts).
 */
export interface ChainConnectionState {
  /** Mutable handshake state. Caller MUST construct one per accepted socket. */
  readonly helloState: HelloConnectionState;
}

/**
 * Daemon-process-scoped wiring. Created once at boot and re-used across all
 * connections.
 *
 * Every field is optional so the chain can be partially-wired during the v0.3
 * cutover (e.g. supervisor channel may have hello but no migration gate; data
 * plane may have everything; tests typically provide just `dispatcher`):
 *
 *   - `helloConfig` omitted        → hello interceptor is a no-op pass-through.
 *   - `helloConfig.daemonSecret` is unset → caller MUST pass `helloConfig` only
 *     when the daemon HMAC keystore is loaded; otherwise the interceptor would
 *     fail-closed on every hello and lock all clients out (#139 lifecycle).
 *   - `metricsRegistry` omitted    → metrics sink is a no-op (counters not bumped).
 *   - `traceLogSink` omitted       → completion log lines are dropped (the
 *     trace span is still computed and `daemonTraceId` is still echoed to the
 *     client; only the local pino line is suppressed).
 *   - `isMigrationPending` omitted → migration gate treats as `false`.
 */
export interface ChainWiring {
  /** Pure dispatcher (supervisor or data plane). MANDATORY. */
  readonly dispatcher: Pick<Dispatcher, 'dispatch'>;

  /** Hello interceptor config. Omit on transports where hello is enforced
   *  elsewhere (e.g. Connect-RPC server). */
  readonly helloConfig?: HelloInterceptorConfig;

  /** Sink for `envelope_trace` completion log lines (pino.info / console.log /
   *  test buffer). When omitted, lines are dropped. */
  readonly traceLogSink?: TraceLogSink;

  /** Per-method counter table. When omitted, metrics are not recorded. */
  readonly metricsRegistry?: MetricsRegistry;

  /** Migration-pending predicate. When omitted, treated as `() => false`. */
  readonly isMigrationPending?: () => boolean;

  /** Injected wall-clock for the trace span. Defaults to `Date.now`. */
  readonly clock?: ClockMs;

  /** Injected trace-id minter. Defaults to crypto-backed 16-byte hex. */
  readonly mintTraceId?: () => string;

  /** Injected daemon-side trace-id minter. Defaults to crypto-backed 16-byte hex. */
  readonly mintDaemonTraceId?: () => string;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * Reply produced by the chain. The envelope adapter serialises this into the
 * wire envelope format. Two kinds of reply:
 *
 *   - `kind: 'ok'`     — handler returned a value (or hello reply payload).
 *                         `value` populates the `value` field of the wire
 *                         envelope; `daemonTraceId` is echoed in the reply
 *                         header slot (`x-ccsm-daemon-trace-id`) so client
 *                         logs can be joined to daemon logs by id.
 *   - `kind: 'error'`  — interceptor or handler rejected. `code` + `message`
 *                         populate the `error` field. `daemonTraceId` is
 *                         still echoed so even rejected calls can be joined.
 *
 * `socketFatal` (only on `kind: 'error'`) signals the adapter to call
 * `socket.destroy()` after writing the reply. Currently set on
 * `hello_required`, `hello_replay`, and `schema_violation` per §3.4.1.g.
 */
export type ChainReply =
  | {
      readonly kind: 'ok';
      readonly id: number;
      readonly value: unknown;
      readonly ackSource: 'handler' | 'dispatcher';
      readonly daemonTraceId: string;
      readonly traceId: string;
    }
  | {
      readonly kind: 'error';
      readonly id: number;
      readonly code: string;
      readonly message: string;
      readonly extras?: Readonly<Record<string, unknown>>;
      readonly daemonTraceId: string;
      readonly traceId: string;
      readonly socketFatal: boolean;
    };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run one envelope through the spec-locked interceptor chain and dispatch.
 *
 * Pure (modulo the injected sinks): the function never reads wall-clock
 * directly (clock is injected), never logs (sink is injected), never mutates
 * the wiring (only `state.helloState` may be mutated by the hello
 * interceptor, per its own SRP contract).
 *
 * The function NEVER throws. Handler exceptions surface as `kind: 'error'`
 * with `code: 'INTERNAL'` so the adapter has a single reply shape to
 * serialise. (The adapter's own try/catch around the dispatcher call is
 * therefore redundant after this wiring lands; kept for defence in depth
 * against future refactors that bypass the chain.)
 */
export async function dispatchWithInterceptors(
  req: EnvelopeRequest,
  state: ChainConnectionState,
  wiring: ChainWiring,
): Promise<ChainReply> {
  const clock = wiring.clock ?? Date.now;
  const traceId = resolveTraceId({ traceId: req.traceId }, wiring.mintTraceId);
  const span = startTrace(req.method, traceId, clock, wiring.mintDaemonTraceId ?? defaultMintTraceId);

  // metrics slot #5 — recordRequest is unconditional; recordError /
  // recordDuration are wired into the completion paths below so a request
  // rejected by ANY interceptor still counts toward the right counters.
  wiring.metricsRegistry?.recordRequest(req.method);

  /** Helper that finalises the trace span + duration histogram + metrics-error
   *  bookkeeping. Called from every termination path so the contract holds:
   *  exactly one trace line + one duration sample + (on rejection) one error
   *  bump per envelope. */
  const finish = (
    code: string,
    isError: boolean,
  ): { durationMs: number } => {
    const log = formatCompletionLog(span, code, clock);
    wiring.traceLogSink?.(log);
    wiring.metricsRegistry?.recordDuration(req.method, log.durationMs);
    if (isError) {
      wiring.metricsRegistry?.recordError(req.method, code);
    }
    return { durationMs: log.durationMs };
  };

  // ---------------------------------------------------------------------
  // Slot #0 — hello gate
  // ---------------------------------------------------------------------
  if (wiring.helloConfig) {
    const decision = decideHello(
      { rpcName: req.method, payload: req.payload, state: state.helloState },
      wiring.helloConfig,
    );
    if (decision.kind === 'reject') {
      finish(decision.code, true);
      return {
        kind: 'error',
        id: req.id,
        code: decision.code,
        message: decision.message,
        daemonTraceId: span.daemonTraceId,
        traceId: span.traceId,
        socketFatal: decision.destroySocket,
      };
    }
    if (decision.kind === 'reply') {
      // Hello succeeded — short-circuit reply, do NOT forward to dispatcher
      // (the hello handshake is owned by the interceptor itself, not by a
      // registered handler).
      finish('ok', false);
      return {
        kind: 'ok',
        id: req.id,
        value: decision.payload satisfies HelloReplyPayload,
        ackSource: 'handler',
        daemonTraceId: span.daemonTraceId,
        traceId: span.traceId,
      };
    }
    // 'pass' → fall through to next slot.
  }

  // ---------------------------------------------------------------------
  // Slot #2 — deadline header policy (slot #1 trace already opened above)
  // ---------------------------------------------------------------------
  const headers = req.headers ?? {};
  const deadlineDecision = applyDeadline({ headers, rpcName: req.method });
  if ('error' in deadlineDecision) {
    finish(deadlineDecision.error.code, true);
    return {
      kind: 'error',
      id: req.id,
      code: deadlineDecision.error.code,
      message: deadlineDecision.error.message,
      extras: { header: DEADLINE_HEADER },
      daemonTraceId: span.daemonTraceId,
      traceId: span.traceId,
      // deadline_invalid is NOT socket-fatal — it's a per-RPC client bug.
      socketFatal: false,
    };
  }
  // deadlineDecision.deadlineMs is forwarded to the dispatcher via ctx.signal
  // below (AbortSignal.timeout). The dispatcher itself does NOT enforce the
  // deadline — handlers do, by reading ctx.signal. Per spec §3.4.1.f, the
  // signal composition is the wiring's job.
  const deadlineSignal = AbortSignal.timeout(deadlineDecision.deadlineMs);

  // ---------------------------------------------------------------------
  // Slot #3 — migration gate
  // ---------------------------------------------------------------------
  const migrationPending = wiring.isMigrationPending?.() === true;
  const gateDecision = checkMigrationGate({ rpcName: req.method, migrationPending });
  if (!gateDecision.allowed) {
    finish(gateDecision.error.code, true);
    return {
      kind: 'error',
      id: req.id,
      code: gateDecision.error.code,
      message: gateDecision.error.message,
      daemonTraceId: span.daemonTraceId,
      traceId: span.traceId,
      socketFatal: false,
    };
  }

  // ---------------------------------------------------------------------
  // Slot #4 — dispatcher (handler invocation)
  // ---------------------------------------------------------------------
  const ctx: DispatchContext = {
    traceId: span.traceId,
    signal: deadlineSignal,
  };

  let result: DispatchResult;
  try {
    result = await wiring.dispatcher.dispatch(req.method, req.payload ?? req, ctx);
  } catch (err) {
    finish('INTERNAL', true);
    return {
      kind: 'error',
      id: req.id,
      code: 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
      daemonTraceId: span.daemonTraceId,
      traceId: span.traceId,
      socketFatal: false,
    };
  }

  if (result.ok) {
    finish('ok', false);
    return {
      kind: 'ok',
      id: req.id,
      value: result.value,
      ackSource: result.ack_source,
      daemonTraceId: span.daemonTraceId,
      traceId: span.traceId,
    };
  }

  finish(result.error.code, true);
  return {
    kind: 'error',
    id: req.id,
    code: result.error.code,
    message: result.error.message,
    extras: { method: result.error.method },
    daemonTraceId: span.daemonTraceId,
    traceId: span.traceId,
    socketFatal: false,
  };
}

// ---------------------------------------------------------------------------
// Reply-header helpers (consumed by the envelope adapter)
// ---------------------------------------------------------------------------

/**
 * Build the reserved-header block that the adapter splices into the reply
 * envelope. Kept as a separate pure helper so the adapter does not have to
 * know the header key (`x-ccsm-daemon-trace-id`). Future reserved reply
 * headers (e.g. `x-ccsm-server-version`) extend this object.
 */
export function buildReplyHeaders(reply: ChainReply): Record<string, string> {
  return {
    [DAEMON_TRACE_ID_HEADER]: reply.daemonTraceId,
  };
}

// Re-export for downstream test convenience.
export { DAEMON_TRACE_ID_HEADER };

// Suppress unused-import warning for Buffer when binary trailers land.
void Buffer;
