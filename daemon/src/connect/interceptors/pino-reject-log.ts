// daemon/src/connect/interceptors/pino-reject-log.ts — Structured pino
// rejection logging helper shared by all decider interceptors.
//
// Spec citation:
//   - docs/superpowers/specs/2026-05-01-v0.4-web-design.md ch02 §8 paragraph 394:
//     "every interceptor that rejects a request (deadline exceeded, migration
//      gate fired, JWT invalid, readMaxBytes exceeded) emits
//      pino.warn({ interceptor, method, traceId, reason })".
//
// Single Responsibility (sink):
//   - This module is the SINK for rejection events. It does NOT decide; the
//     calling interceptor decides + throws + calls this for the audit trail.
//
// The logger is injected (not imported from a global) so callers can swap in
// a child logger or a no-op for tests. We default to `console.warn` so the
// helper still surfaces signal in early-boot / harness contexts that haven't
// wired pino yet (matches data-socket.ts logger fallback pattern).

export interface RejectLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RejectLogFields {
  /** Interceptor slot name, e.g. `'jwt'` / `'migration-gate'` / `'storage-full'`. */
  readonly interceptor: string;
  /** Connect RPC method name (`req.method.name`). */
  readonly method: string;
  /** Per-request ULID trace-id (may be empty if reject happens before trace-id slot). */
  readonly traceId: string;
  /** Connect Code numeric value (e.g. `Code.Unauthenticated === 16`). */
  readonly rejectCode: number;
  /** Transport tag at time of reject (`'local-pipe'` / `'remote-tcp'` / `'untagged'`). */
  readonly transportTag: string;
  /** Optional duration ms from request start to reject. */
  readonly durationMs?: number;
  /** Optional human-readable reason / diagnostic. */
  readonly reason?: string;
  /** Optional RPC URL path (e.g. `/ccsm.v1.CcsmService/Ping`). */
  readonly rpcPath?: string;
}

const DEFAULT_LOGGER: RejectLogger = {
  warn(obj, msg) {
    // Best-effort; matches the data-socket.ts fallback pattern. Production
    // wires a real pino child via the daemon shell (daemon/src/index.ts).
    console.warn(`${msg} ${JSON.stringify(obj)}`);
  },
};

/**
 * Emit a single structured rejection log line. Always logs — the caller
 * decides the gate. Returns void; never throws (logging must not raise).
 */
export function logReject(
  logger: RejectLogger | undefined,
  fields: RejectLogFields,
): void {
  const sink = logger ?? DEFAULT_LOGGER;
  try {
    sink.warn(
      {
        interceptor: fields.interceptor,
        method: fields.method,
        traceId: fields.traceId,
        rejectCode: fields.rejectCode,
        transportTag: fields.transportTag,
        ...(fields.rpcPath !== undefined ? { rpcPath: fields.rpcPath } : {}),
        ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
        ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
      },
      'connect_interceptor_reject',
    );
  } catch {
    /* swallow — logging must never fail the request path. */
  }
}
