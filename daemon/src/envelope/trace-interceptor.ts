// L1 envelope trace interceptor (spec §3.4.1.f built-in interceptor list — slot
// "trace", before deadline / migrationGate / metrics).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.f bullet "trace": every envelope MUST carry a `traceId`; when the
//     caller omits it, the interceptor mints a fresh one and attaches it to the
//     per-request context so downstream interceptors / handler logs / pino
//     child loggers can fan it through. On completion the interceptor emits a
//     canonical log line `envelope_trace { method, traceId, durationMs, code }`
//     so a grep over the daemon log file reconstructs every RPC's span.
//   - Same fragment §3.4.1.c reserved-fields list (`traceId` is an envelope
//     header field; Crockford ULID when caller-supplied, but the interceptor
//     accepts any non-empty string so a pre-existing trace propagated by a
//     v0.5 web client survives unchanged).
//
// Single Responsibility (producer / decider / sink discipline):
//   - This module is a PURE DECIDER plus a single deterministic SINK callback.
//     It exposes:
//       - `resolveTraceId(envelope)`         — pick existing traceId or mint one.
//       - `startTrace(method, traceId, now)` — open a per-call span (records
//                                              start ms via injected clock).
//       - `formatCompletionLog(span, code)`  — build the canonical completion
//                                              record (does NOT write to a sink).
//       - `runWithTrace(...)`                — convenience wrapper that ties
//                                              the three together and invokes
//                                              the caller-supplied logger sink
//                                              exactly once on completion.
//   - It does NOT own a logger instance, does NOT touch wall-clock directly
//     (the clock is injected so tests are deterministic), does NOT mutate
//     the envelope, and does NOT swallow handler errors (errors propagate to
//     the caller after the completion log is recorded).

import { randomBytes } from 'node:crypto';

/**
 * Length of an interceptor-minted trace id. Spec §3.4.1.c canonical format is
 * a Crockford ULID (26 chars) when the CLIENT supplies one; for daemon-minted
 * fallbacks we use a 16-byte (32-char) hex string per the task brief — easy
 * to grep, no ulid dep churn, and visually distinct from a client ULID so a
 * future audit can tell who minted the id.
 */
export const TRACE_ID_BYTES = 16;

/**
 * Canonical name of the completion log event. Stable across versions —
 * dashboards / alerts grep on the literal string per spec §3.4.1.f.
 */
export const TRACE_LOG_EVENT = 'envelope_trace';

/**
 * Reserved reply-envelope header that carries the daemon-minted id back to
 * the caller (#153 N13-fix). Mirrors the lower-cased `x-ccsm-*` family used
 * by other reserved headers (`x-ccsm-deadline-ms`, `x-ccsm-trace-id`).
 *
 * The envelope adapter copies this from the trace span into the reply
 * envelope's reserved-header slot so the client can log the join id without
 * having to grep daemon logs first.
 */
export const DAEMON_TRACE_ID_HEADER = 'x-ccsm-daemon-trace-id';

/** Minimum envelope shape this interceptor reads. Header field per §3.4.1.c. */
export interface TraceEnvelopeView {
  /** Optional caller-supplied traceId. Empty string treated as absent. */
  readonly traceId?: string | null;
}

/** Injected wall-clock. Defaults to `Date.now`; tests pass a deterministic stub. */
export type ClockMs = () => number;

/** In-flight span returned by {@link startTrace}. Opaque to callers. */
export interface TraceSpan {
  readonly method: string;
  /** Client-supplied or fallback-minted id (back-compat with #809). */
  readonly traceId: string;
  /** Daemon-always-minted join id (#153 N13-fix). */
  readonly daemonTraceId: string;
  readonly startedMs: number;
}

/** Canonical completion log record (spec §3.4.1.f).
 *
 *  Dual-id (#153 N13-fix, this PR): the legacy `traceId` field continues to
 *  carry the **client-supplied or minted** id (back-compat with #809); the
 *  new `daemonTraceId` field carries an additional id that the DAEMON always
 *  mints itself, regardless of whether the client supplied a `traceId`. The
 *  two-id design lets log joins work both ways:
 *    - Client log → daemon log: grep by `traceId` (client knows this value).
 *    - Daemon log → client log: pin by `daemonTraceId` echoed back to the
 *      client in the reply envelope (`x-ccsm-daemon-trace-id` reserved
 *      header), so a daemon-side bug report can ask the user for that id and
 *      pull their client-side line. */
export interface TraceCompletionLog {
  readonly event: typeof TRACE_LOG_EVENT;
  readonly method: string;
  /** Client-supplied trace id, OR — when the client omitted one — the value
   *  the daemon minted as the `traceId` fallback (back-compat with #809). */
  readonly traceId: string;
  /** Daemon-minted id, ALWAYS present, ALWAYS distinct from `traceId` even
   *  when the client did not supply one (the daemon mints two separate ids
   *  in that case). Echoed to the client in the reply trailer so logs from
   *  both sides can be joined when the client did NOT supply a `traceId`. */
  readonly daemonTraceId: string;
  readonly durationMs: number;
  /**
   * Wire-level outcome code:
   *   - `'ok'`                      — handler resolved successfully.
   *   - any envelope reject code    — `'hello_required'`, `'MIGRATION_PENDING'`,
   *                                   `'deadline_invalid'`, `'INTERNAL'`, etc.
   *
   * Kept as a free-form string because the v0.3 envelope reject vocabulary
   * spans multiple interceptors and a handful of dispatcher codes; a closed
   * union here would force a churn every time a new interceptor lands.
   */
  readonly code: string;
}

/** Sink that consumes the completion log. Implementations: pino.info, console.log, in-mem buffer. */
export type TraceLogSink = (record: TraceCompletionLog) => void;

/**
 * Pick the caller-supplied traceId or mint a 16-byte hex id. Empty / whitespace
 * strings are treated as absent so a client that sets `traceId: ""` does not
 * silently disable tracing.
 *
 * Pure modulo `randomBytes` (system entropy); the caller may inject `mintTraceId`
 * to make the function fully deterministic in tests.
 */
export function resolveTraceId(
  envelope: TraceEnvelopeView,
  mintTraceId: () => string = defaultMintTraceId,
): string {
  const supplied = envelope.traceId;
  if (typeof supplied === 'string' && supplied.trim().length > 0) {
    return supplied;
  }
  return mintTraceId();
}

/** Default 16-byte hex minter. Safe-by-default; tests inject deterministic stubs. */
export function defaultMintTraceId(): string {
  return randomBytes(TRACE_ID_BYTES).toString('hex');
}

/**
 * Open a per-call span. Records the start time via the injected clock so
 * `formatCompletionLog` can compute `durationMs` without re-reading the clock
 * inconsistently across paths.
 *
 * Mints a daemon-side join id (`daemonTraceId`) regardless of whether the
 * caller supplied a `traceId` (#153 N13-fix). The daemon id is ALWAYS a fresh
 * 16-byte hex string from {@link defaultMintTraceId} (or the injected
 * `mintDaemonTraceId` for tests) — it never reuses `traceId`, even when the
 * client omits the field. This guarantees the dual-id correlation property:
 * even when the client did not name the request, the daemon's own logs
 * carry a stable id the user can quote in a bug report.
 */
export function startTrace(
  method: string,
  traceId: string,
  now: ClockMs = Date.now,
  mintDaemonTraceId: () => string = defaultMintTraceId,
): TraceSpan {
  return {
    method,
    traceId,
    daemonTraceId: mintDaemonTraceId(),
    startedMs: now(),
  };
}

/**
 * Build the canonical completion record. Pure — does NOT write to a sink.
 * Caller passes the `code` (`'ok'` for handler success or the wire-level
 * reject/error code) plus the `now()` reading captured at completion.
 */
export function formatCompletionLog(
  span: TraceSpan,
  code: string,
  now: ClockMs = Date.now,
): TraceCompletionLog {
  // Math.max guards against a non-monotonic clock (e.g. NTP slew during a
  // long-running unary RPC) producing a negative durationMs in the log.
  const durationMs = Math.max(0, now() - span.startedMs);
  return {
    event: TRACE_LOG_EVENT,
    method: span.method,
    traceId: span.traceId,
    daemonTraceId: span.daemonTraceId,
    durationMs,
    code,
  };
}

/**
 * Convenience wrapper that ties resolve / start / format / sink together for
 * the common dispatcher path. Returns the handler's resolved value (or
 * re-throws its error AFTER recording the completion log so the trace span is
 * never lost on the error path).
 *
 * The caller passes:
 *   - `envelope`   — the inbound envelope view (for traceId pickup).
 *   - `method`     — the wire-literal RPC name.
 *   - `handler`    — async fn that receives `{ traceId }` (so a pino child can
 *                    bind the trace id) and resolves with `{ value, code }`.
 *                    `code` defaults to `'ok'` on resolve; on throw the wrapper
 *                    fills `'INTERNAL'`. A handler that wants to surface a more
 *                    specific code (e.g. `'NOT_IMPLEMENTED'`) returns
 *                    `{ value, code: 'NOT_IMPLEMENTED' }` without throwing.
 *   - `sink`       — completion log sink (pino.info / console.log / test stub).
 *   - `clock`      — optional injected clock; defaults to `Date.now`.
 *   - `mintTraceId`— optional injected minter; defaults to crypto.randomBytes.
 */
export interface RunWithTraceArgs<T> {
  readonly envelope: TraceEnvelopeView;
  readonly method: string;
  readonly handler: (ctx: { readonly traceId: string; readonly daemonTraceId: string }) => Promise<{
    readonly value: T;
    readonly code?: string;
  }>;
  readonly sink: TraceLogSink;
  readonly clock?: ClockMs;
  readonly mintTraceId?: () => string;
  /** Optional override for the daemon-side join id minter (#153 N13-fix).
   *  Defaults to {@link defaultMintTraceId}; tests pass a deterministic stub. */
  readonly mintDaemonTraceId?: () => string;
}

export async function runWithTrace<T>(args: RunWithTraceArgs<T>): Promise<T> {
  const { envelope, method, handler, sink } = args;
  const clock = args.clock ?? Date.now;
  const traceId = resolveTraceId(envelope, args.mintTraceId);
  const span = startTrace(method, traceId, clock, args.mintDaemonTraceId);

  try {
    const result = await handler({ traceId, daemonTraceId: span.daemonTraceId });
    sink(formatCompletionLog(span, result.code ?? 'ok', clock));
    return result.value;
  } catch (err) {
    // Record the failure span THEN rethrow — sink-before-throw guarantees the
    // trace line lands even if the caller's catch swallows the error.
    sink(formatCompletionLog(span, 'INTERNAL', clock));
    throw err;
  }
}
