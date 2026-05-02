// Control-socket / data-socket dispatcher — literal-method router with
// plane-scoped allowlist enforcement.
//
// T16 (PR #x): introduced supervisor-only `Dispatcher` pre-wired with
//   SUPERVISOR_RPCS allowlist (frag-3.4.1 §3.4.1.h).
// T23 (this commit): generalised to a two-plane dispatcher. Supervisor plane
//   continues to enforce the SUPERVISOR_RPCS allowlist at the boundary;
//   data plane skips the allowlist (its surface is governed by separate
//   per-method registration + envelope HMAC + hello-required gates and is
//   declared by the data-socket transport).
//
// T24 (frag-6-7 §6.3 ack-source clarification): every successful reply carries
// `ack_source: 'handler' | 'dispatcher'` so the transport (T14) can disambiguate
// handler-result acks from streaming-init dispatcher acks. `dispatch()` (unary)
// fills `'handler'` on success; `dispatchStreamingInit()` fills `'dispatcher'`.
// Existing handlers are untouched — the field is set by the dispatch entry
// point used, not the handler.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.h (control-socket: `/healthz`, `/stats`, `daemon.hello`,
//     `daemon.shutdown`, `daemon.shutdownForUpgrade`).
//   - frag-6-7 §6.1 + §6.2 (supervisor RPCs allowlist enforcement at the
//     dispatcher boundary; data-socket has its own surface).
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

/**
 * Source of a successful reply envelope (T24, frag-6-7 §6.3 ack-semantics
 * disambiguation).
 *
 *   - `'handler'`    — the registered handler ran to completion and its
 *                      return value populates `DispatchOk.value`. This is the
 *                      ack a unary RPC caller waits for.
 *   - `'dispatcher'` — the dispatcher accepted the request and started a
 *                      streaming response, but no handler return value exists
 *                      yet. The transport (T14) emits this as the
 *                      streaming-init ack so the client knows the request
 *                      reached the dispatcher; subsequent stream frames carry
 *                      the actual data, and a terminal `'handler'`-sourced
 *                      reply closes the stream.
 *
 * The field is filled automatically by the dispatch entry point used; handlers
 * never set it themselves.
 */
export type AckSource = 'handler' | 'dispatcher';

/** All legal `ack_source` values. Exported so schema validators / tests can
 *  enumerate without re-declaring the union. */
export const ACK_SOURCES: readonly AckSource[] = ['handler', 'dispatcher'] as const;

/** Type-guard for envelope-level schema validation (T5 envelope adapter / T14
 *  control-socket reply serialiser). Returns true for the two canonical
 *  values, false otherwise. */
export function isAckSource(v: unknown): v is AckSource {
  return v === 'handler' || v === 'dispatcher';
}

export interface DispatchOk {
  readonly ok: true;
  readonly value: unknown;
  /** Source of this reply envelope — see {@link AckSource}. Always present;
   *  unary `dispatch()` returns `'handler'`, `dispatchStreamingInit()` returns
   *  `'dispatcher'`. */
  readonly ack_source: AckSource;
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

/** Dispatcher plane (T23). Supervisor plane enforces the SUPERVISOR_RPCS
 *  allowlist at the dispatcher boundary; data plane delegates surface
 *  control to per-method registration only (its envelope HMAC + hello-gate
 *  live in the data-socket transport, not here). */
export type DispatcherPlane = 'supervisor' | 'data';

export interface DispatcherOptions {
  /** Defaults to `'supervisor'` for backward compatibility with T16
   *  consumers (`new Dispatcher()` continues to enforce SUPERVISOR_RPCS). */
  readonly plane?: DispatcherPlane;
}

/** Build the default supervisor-plane dispatcher pre-wired with
 *  NOT_IMPLEMENTED stubs for the five canonical SUPERVISOR_RPCS. T17–T21
 *  each call `register()` (or build their own dispatcher in tests) to swap
 *  a stub for a real handler. */
export function createSupervisorDispatcher(): Dispatcher {
  const d = new Dispatcher({ plane: 'supervisor' });
  // Stub registration order mirrors the SUPERVISOR_RPCS tuple so the wire
  // contract row in §3.4.1.h and this file stay visually 1:1.
  for (const method of SUPERVISOR_RPCS) {
    d.register(method, stubHandler(method));
  }
  return d;
}

/** Build a bare data-plane dispatcher. The data-socket transport calls
 *  `register()` for each data-plane RPC it owns; the dispatcher does NOT
 *  apply the SUPERVISOR_RPCS allowlist. Unknown methods still resolve to
 *  UNKNOWN_METHOD per the standard decision table. */
export function createDataDispatcher(): Dispatcher {
  return new Dispatcher({ plane: 'data' });
}

/**
 * Literal-method router with plane-scoped allowlist enforcement.
 *
 * Supervisor-plane responsibilities (T23 — boundary enforcement):
 *   1. Reject non-allowlisted method names with NOT_ALLOWED (defence in
 *      depth — handlers stay simple and never see disallowed methods).
 *   2. Reject unknown allowlisted methods (allowlisted name with no
 *      registered handler) with UNKNOWN_METHOD.
 *   3. Invoke the registered handler and forward its resolved value.
 *   4. Convert a thrown `NotImplementedError` from a stub into a typed
 *      NOT_IMPLEMENTED reply (does NOT escape as an unhandled rejection).
 *
 * Data-plane responsibilities:
 *   - Skip the SUPERVISOR_RPCS allowlist gate entirely. Surface control is
 *     declared by the data-socket transport via per-method `register()`.
 *   - All other behaviour (UNKNOWN_METHOD for missing handler, stub
 *     conversion, exception propagation) is identical to supervisor plane.
 *
 * Non-responsibilities (intentional, per Single Responsibility):
 *   - No envelope parsing / serialisation (lives in T14 control-socket).
 *   - No deadline enforcement (deadlineInterceptor §3.4.1.f).
 *   - No metrics emission (metricsInterceptor §3.4.1.f).
 *   - No allowlist mutation — `SUPERVISOR_RPCS` is the single source of truth.
 *   - No normalisation (literal compare, per §3.4.1.h carve-out lock).
 *   - No envelope HMAC / hello-required gating on data plane (those live in
 *     the data-socket transport itself).
 */
export class Dispatcher {
  readonly #handlers: Map<string, Handler> = new Map();
  readonly #plane: DispatcherPlane;

  constructor(opts: DispatcherOptions = {}) {
    this.#plane = opts.plane ?? 'supervisor';
  }

  /** Plane this dispatcher was constructed with (test-facing helper). */
  get plane(): DispatcherPlane {
    return this.#plane;
  }

  /** Register or replace the handler for a method.
   *
   *  Supervisor plane: throws if `method` is not a SUPERVISOR_RPCS member —
   *  registering a handler the dispatcher would never call is a programming
   *  error and must fail loud at boot (per Single Responsibility: producer
   *  must use the canonical allowlist).
   *
   *  Data plane: accepts any method name; the data-socket transport owns
   *  surface declaration. */
  register(method: string, handler: Handler): void {
    if (this.#plane === 'supervisor' && !isSupervisorRpc(method)) {
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
   * Decision table (supervisor plane):
   *   isSupervisorRpc=false                       → NOT_ALLOWED
   *   isSupervisorRpc=true  ∧ no handler          → UNKNOWN_METHOD
   *   isSupervisorRpc=true  ∧ handler throws stub → NOT_IMPLEMENTED
   *   isSupervisorRpc=true  ∧ handler resolves    → { ok: true, value }
   *
   * Decision table (data plane):
   *   no handler                                  → UNKNOWN_METHOD
   *   handler throws stub                         → NOT_IMPLEMENTED
   *   handler resolves                            → { ok: true, value }
   *
   * Handler exceptions OTHER than the stub sentinel are NOT swallowed —
   * they propagate to the caller (T14) which owns wire-level error mapping.
   *
   * NOT_ALLOWED messages intentionally do NOT enumerate the allowlist — the
   * caller learns only that their method is rejected, not which methods
   * exist. This avoids leaking the supervisor-plane surface to data-plane
   * clients that probe with random method names.
   */
  async dispatch(
    method: string,
    req: unknown,
    ctx: DispatchContext,
  ): Promise<DispatchResult> {
    if (this.#plane === 'supervisor' && !isSupervisorRpc(method)) {
      return {
        ok: false,
        error: {
          code: 'NOT_ALLOWED',
          method,
          message: `RPC ${JSON.stringify(method)} is not allowed on the supervisor / control-socket plane (SUPERVISOR_RPCS, §3.4.1.h)`,
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
          message: `no handler registered for ${this.#plane}-plane RPC ${method}`,
        },
      };
    }

    try {
      const value = await handler(req, ctx);
      // T24: handler-completion path — the registered handler returned a
      // value, so the reply envelope's ack source is `'handler'`.
      return { ok: true, value, ack_source: 'handler' };
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

  /**
   * Streaming-init dispatch: announce that a streaming RPC has been received
   * and routed, BEFORE any handler return value exists (T24, frag-6-7 §6.3).
   *
   * Used by the transport (T14) when the caller's request opens a streaming
   * response: the transport emits this `'dispatcher'`-sourced reply
   * immediately so the client can begin receiving stream frames; the eventual
   * terminal reply (sent when the handler completes) carries
   * `ack_source: 'handler'` via the regular `dispatch()` path.
   *
   * The same allowlist + UNKNOWN_METHOD checks apply as `dispatch()` — the
   * dispatcher is the single decider on whether a method may be invoked at
   * all, regardless of unary vs. streaming response shape. The handler is
   * NOT invoked here; only the routing decision is made.
   *
   * Returns:
   *   - `{ ok: true, value: undefined, ack_source: 'dispatcher' }` on a
   *     routable method (handler exists). The transport serialises this as
   *     the streaming-init ack envelope; `value` is `undefined` because no
   *     handler return value exists yet (the stream is the value).
   *   - `{ ok: false, error: NOT_ALLOWED | UNKNOWN_METHOD }` on rejection.
   */
  dispatchStreamingInit(method: string): DispatchResult {
    // Plane-scoped allowlist (T92 fix): supervisor plane enforces
    // SUPERVISOR_RPCS at the boundary; data plane delegates surface control
    // to per-method registration just like `dispatch()` does. Without this
    // gate the data-socket streaming envelope (frag-3.4.1 §3.4.1.b) would
    // get a hard NOT_ALLOWED on every legitimate `pty.subscribe` open even
    // though the dispatcher is in data plane.
    if (this.#plane === 'supervisor' && !isSupervisorRpc(method)) {
      return {
        ok: false,
        error: {
          code: 'NOT_ALLOWED',
          method,
          message: `RPC ${JSON.stringify(method)} is not on the control-socket allowlist (SUPERVISOR_RPCS, §3.4.1.h)`,
        },
      };
    }
    if (!this.#handlers.has(method)) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_METHOD',
          method,
          message: `no handler registered for ${this.#plane}-plane streaming RPC ${method}`,
        },
      };
    }
    return { ok: true, value: undefined, ack_source: 'dispatcher' };
  }
}
