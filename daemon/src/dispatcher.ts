// Control-socket dispatcher (T16) — literal-method router for the canonical
// SUPERVISOR_RPCS allowlist (frag-3.4.1 §3.4.1.h).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.h (control-socket: `/healthz`, `/stats`, `daemon.hello`,
//     `daemon.shutdown`, `daemon.shutdownForUpgrade`).
//   - frag-6-7 §6.5 (supervisor transport = the `ccsm-control` socket; the
//     control-socket dispatcher is the routing surface on that transport).
//   - T11 (PR #646) landed the canonical `SUPERVISOR_RPCS` constant + the
//     `isSupervisorRpc` predicate; this dispatcher is its first consumer.
//
// Single Responsibility: pure decider + handler invoker.
//   - Producers: the control-socket transport (T14, parallel) parses envelopes
//     and calls `dispatch(method, req, ctx)`.
//   - Decider: the dispatcher checks the allowlist and routes to a handler.
//   - Sink: the registered handler performs the actual side effect (read
//     `/healthz` snapshot, write `/stats`, run shutdown, etc.). Handlers are
//     stub implementations until T17–T21 replace them.
//
// This module performs ZERO socket I/O. Wiring to a Duplex stream is the
// caller's responsibility (T14 control-socket.ts).

import { isSupervisorRpc, SUPERVISOR_RPCS } from './envelope/supervisor-rpcs.js';

/** Opaque per-call context. Shape locked by T14/T19 — for T16 the dispatcher
 *  treats it as opaque and just forwards it to the registered handler. */
export interface DispatchContext {
  /** Crockford ULID of the originating client request (envelope `traceId`). */
  readonly traceId?: string;
  /** Wall-clock deadline derived from `x-ccsm-deadline-ms` (§3.4.1.c).
   *  Forwarded to handlers; the dispatcher itself does NOT enforce it. */
  readonly signal?: AbortSignal;
}

/** Generic handler signature. Payload + reply types are method-specific and
 *  validated by each handler against its TypeBox schema (per §3.4.1.d
 *  handler-arg discipline). The dispatcher is method-name-typed only. */
export type Handler = (
  req: unknown,
  ctx: DispatchContext,
) => Promise<unknown>;

/** Typed error envelope returned to the caller. Mirrors the wire-level
 *  rejection-frame shape used by other interceptors (e.g. migrationGate
 *  `MIGRATION_PENDING`). The transport layer (T14) is responsible for
 *  serialising this into an envelope error frame. */
export interface DispatcherError {
  readonly code:
    | 'UNKNOWN_METHOD'
    | 'NOT_ALLOWED'
    | 'NOT_IMPLEMENTED';
  readonly method: string;
  readonly message: string;
}

export interface DispatchOk {
  readonly ok: true;
  readonly value: unknown;
}

export interface DispatchErr {
  readonly ok: false;
  readonly error: DispatcherError;
}

export type DispatchResult = DispatchOk | DispatchErr;

/** Stub reply emitted by the placeholder handlers for T17–T21. Each
 *  follow-up task replaces the corresponding stub with a real handler. */
function stubHandler(method: string): Handler {
  return async (_req, _ctx): Promise<never> => {
    // Throwing a sentinel here would couple the stub to the dispatcher's error
    // path. Instead we return a value the dispatcher recognises and converts
    // into a NOT_IMPLEMENTED error envelope. Keeps the stub contract pure.
    throw new NotImplementedError(method);
  };
}

class NotImplementedError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`handler for ${method} is not implemented yet`);
    this.name = 'NotImplementedError';
    this.method = method;
  }
}

/** Build the default dispatcher pre-wired with NOT_IMPLEMENTED stubs for the
 *  five canonical SUPERVISOR_RPCS. T17–T21 each call `register()` (or build
 *  their own dispatcher in tests) to swap a stub for a real handler. */
export function createSupervisorDispatcher(): Dispatcher {
  const d = new Dispatcher();
  // Stub registration order mirrors the SUPERVISOR_RPCS tuple so the wire
  // contract row in §3.4.1.h and this file stay visually 1:1.
  for (const method of SUPERVISOR_RPCS) {
    d.register(method, stubHandler(method));
  }
  return d;
}

/**
 * Literal-method router for the supervisor / control-socket plane.
 *
 * Responsibilities:
 *   1. Reject non-allowlisted method names with NOT_ALLOWED (defence in depth
 *      — the data-socket has its own dispatcher with a disjoint allowlist).
 *   2. Reject unknown allowlisted methods (e.g. an allowlisted name with no
 *      registered handler) with UNKNOWN_METHOD.
 *   3. Invoke the registered handler and forward its resolved value.
 *   4. Convert a thrown `NotImplementedError` from a stub into a typed
 *      NOT_IMPLEMENTED reply (does NOT escape as an unhandled rejection).
 *
 * Non-responsibilities (intentional, per Single Responsibility):
 *   - No envelope parsing / serialisation (lives in T14 control-socket).
 *   - No deadline enforcement (deadlineInterceptor §3.4.1.f).
 *   - No metrics emission (metricsInterceptor §3.4.1.f).
 *   - No allowlist mutation — `SUPERVISOR_RPCS` is the single source of truth.
 *   - No normalisation (literal compare, per §3.4.1.h carve-out lock).
 */
export class Dispatcher {
  readonly #handlers: Map<string, Handler> = new Map();

  /** Register or replace the handler for a canonical RPC method.
   *
   *  Throws if `method` is not a SUPERVISOR_RPCS member — registering a
   *  handler the dispatcher would never call is a programming error and must
   *  fail loud at boot (per Single Responsibility: producer must use the
   *  canonical allowlist). */
  register(method: string, handler: Handler): void {
    if (!isSupervisorRpc(method)) {
      throw new Error(
        `Dispatcher.register: refusing to register non-supervisor RPC ${JSON.stringify(method)}; only SUPERVISOR_RPCS (§3.4.1.h) are routable on the control socket`,
      );
    }
    this.#handlers.set(method, handler);
  }

  /** Inspect whether a handler is currently registered (test-facing helper). */
  has(method: string): boolean {
    return this.#handlers.has(method);
  }

  /**
   * Route an inbound RPC to its handler.
   *
   * Decision table:
   *   isSupervisorRpc=false                       → NOT_ALLOWED
   *   isSupervisorRpc=true  ∧ no handler          → UNKNOWN_METHOD
   *   isSupervisorRpc=true  ∧ handler throws stub → NOT_IMPLEMENTED
   *   isSupervisorRpc=true  ∧ handler resolves    → { ok: true, value }
   *
   * Handler exceptions OTHER than the stub sentinel are NOT swallowed —
   * they propagate to the caller (T14) which owns wire-level error mapping.
   */
  async dispatch(
    method: string,
    req: unknown,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (!isSupervisorRpc(method)) {
      return {
        ok: false,
        error: {
          code: 'NOT_ALLOWED',
          method,
          message: `RPC ${JSON.stringify(method)} is not on the control-socket allowlist (SUPERVISOR_RPCS, §3.4.1.h)`,
        },
      };
    }

    const handler = this.#handlers.get(method);
    if (!handler) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_METHOD',
          method,
          message: `no handler registered for control-socket RPC ${method}`,
        },
      };
    }

    try {
      const value = await handler(req, ctx);
      return { ok: true, value };
    } catch (err) {
      if (err instanceof NotImplementedError) {
        return {
          ok: false,
          error: {
            code: 'NOT_IMPLEMENTED',
            method: err.method,
            message: err.message,
          },
        };
      }
      throw err;
    }
  }
}
