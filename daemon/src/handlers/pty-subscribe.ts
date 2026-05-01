// `ccsm.v1/pty.subscribe` — Connect-style server-streaming RPC handler
// (T-NEW, required by L8 drop-slowest probe #1036).
//
// Responsibilities:
//   1. Validate the requested ptyId against an injected predicate (the
//      session table, owned by the lifecycle layer; the registry itself
//      does not enforce existence — it would happily create an empty
//      subscriber set for a bogus id, which is not what callers want).
//   2. Subscribe the caller to the per-session fan-out registry
//      (`daemon/src/pty/fanout-registry.ts`).
//   3. Stream every broadcast frame to the caller via the transport-
//      provided `push` callback until the caller disconnects (transport
//      invokes `cancel()`) or the registry drains the session (handler
//      receives `close(reason)` from the registry and ends the stream).
//   4. Honour the existing drop-slowest 1 MiB watermark + replay-burst
//      exemption — both already live in `pty/drop-slowest.ts` and are
//      composed by the producer that calls `registry.broadcast()`. This
//      handler does NOT duplicate that accounting; it forwards what the
//      registry hands it, and trusts that the producer side has already
//      decided whether to drop or pass.
//
// Single Responsibility (per feedback_single_responsibility):
//   - Producer of subscriber-lifecycle events: NO — that is the registry.
//   - Decider: limited — only the ptyId-validity gate at subscribe time.
//   - Sink: yes — translates registry callbacks to transport `push`/`end`.
//
// Hard non-goals (push back if asked to add):
//   - No envelope encoding (data-socket transport owns wire framing).
//   - No HMAC / hello-required gating (envelope interceptors own that).
//   - No boot-nonce stamping or `bootChanged` emission (T44 wiring layer
//     concern — separate task).
//   - No replay-burst exemption logic (drop-slowest module owns it; the
//     producer that calls `registry.broadcast()` is the seam).
//   - No deadline enforcement on the stream as a whole (spec §3.5: 5s
//     unary deadline applies only to first byte; stream lifetime is
//     bounded by the registry drain or caller disconnect).
//
// Wiring (one-liner at daemon shell):
//
//   import { createDataDispatcher } from '../dispatcher.js';
//   import { createFanoutRegistry } from '../pty/fanout-registry.js';
//   import {
//     PTY_SUBSCRIBE_METHOD,
//     registerPtySubscribeHandler,
//   } from './handlers/pty-subscribe.js';
//
//   const registry = createFanoutRegistry<PtySubscribeFrame>();
//   const dispatcher = createDataDispatcher();
//   registerPtySubscribeHandler(dispatcher, {
//     registry,
//     isValidPtyId: (id) => sessionTable.has(id),
//   });
//
// The data-plane dispatcher accepts any method name (no SUPERVISOR_RPCS
// allowlist on the data plane — see `dispatcher.ts` createDataDispatcher
// docstring). The PTY_SUBSCRIBE_METHOD literal is therefore the only
// "allowlist" entry for this RPC, declared here so renderer + daemon
// agree on the wire string.

import type { Dispatcher, DispatchContext, Handler } from '../dispatcher.js';
import type {
  DrainReason,
  FanoutRegistry,
  Subscriber,
} from '../pty/fanout-registry.js';

/**
 * Canonical wire method name for the `pty.subscribe` server-streaming RPC.
 *
 * Lives under the `ccsm.v1/` namespace per spec §3.4.1.g (data-plane RPCs
 * MUST be namespaced; only the SUPERVISOR_RPCS carve-out keeps HTTP-style
 * literal names).
 */
export const PTY_SUBSCRIBE_METHOD = 'ccsm.v1/pty.subscribe' as const;

/**
 * Default frame shape streamed by this handler. Mirrors the renderer-side
 * envelope shape documented in the v0.3 plan
 * (docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md L1225-L1290):
 *
 *   { kind: "delta", seq, data }
 *
 * Plus a `bootChanged` variant left as `unknown` here — the boot-nonce
 * stamper (T44) decides when to emit it; this handler is shape-agnostic
 * and forwards whatever the registry broadcasts.
 *
 * Callers that want a stronger frame typing parameterise the registry on
 * `<PtySubscribeFrame>` so the message arriving in `deliver()` is already
 * narrowed.
 */
export type PtySubscribeFrame =
  | { readonly kind: 'delta'; readonly seq: number; readonly data: Uint8Array }
  | { readonly kind: 'bootChanged'; readonly bootNonce: string; readonly snapshotPending: true }
  | { readonly kind: 'heartbeat'; readonly ts: number };

/**
 * Request payload schema for `pty.subscribe`. The handler ignores
 * `fromSeq` and `fromBootNonce` — those are wired by the boot-nonce
 * stamper (T44) and the snapshot layer (T45) on top of this handler.
 * Declared here so the wire schema validator (envelope adapter, T5) has
 * one place to import from.
 */
export interface PtySubscribeRequest {
  readonly ptyId: string;
  /** Optional resubscribe cursor — honoured by the snapshot layer; this
   *  handler does not look at it. */
  readonly fromSeq?: number;
  /** Optional resubscribe nonce — see {@link PtySubscribeRequest.fromSeq}. */
  readonly fromBootNonce?: string;
}

/**
 * Reasons the handler may emit when ending a stream. Mirrors the spec's
 * vocabulary so the transport can map each to a Connect-style status code.
 */
export type PtySubscribeEndReason =
  | { readonly kind: 'pty-exit'; readonly detail?: string }
  | { readonly kind: 'pty-crashed'; readonly detail?: string }
  | { readonly kind: 'daemon-shutdown'; readonly detail?: string }
  | { readonly kind: 'session-removed'; readonly detail?: string }
  | { readonly kind: 'caller-cancel' }
  | { readonly kind: 'invalid-pty-id'; readonly ptyId: string }
  | { readonly kind: 'invalid-request'; readonly detail: string };

/**
 * Transport-supplied per-stream callbacks. The data-socket transport
 * builds one `PtySubscribeStream` per accepted streaming-init RPC and
 * wires `push`/`end` to envelope writes on the underlying Duplex.
 *
 * `cancel` is the inverse: the transport invokes it when the caller
 * disconnects (socket `close` event or explicit cancel envelope) so the
 * handler can unsubscribe from the registry.
 */
export interface PtySubscribeStream {
  /** Push one frame to the caller. The transport is responsible for
   *  serialising + writing; backpressure (drop-slowest) is accounted by
   *  the producer side that calls `registry.broadcast()`. */
  push(frame: PtySubscribeFrame): void;
  /** End the stream cleanly. The transport serialises a terminal reply
   *  envelope and closes the per-stream channel. Idempotent: subsequent
   *  calls are no-ops. */
  end(reason: PtySubscribeEndReason): void;
}

/**
 * Injected runtime context. The daemon shell owns all live state and
 * passes one `PtySubscribeContext` instance into the registration
 * helper; the handler stays a pure function over `(req, stream, ctx)`.
 */
export interface PtySubscribeContext {
  /** The per-session fan-out registry instance shared across all PTY
   *  sessions in the daemon process. */
  readonly registry: FanoutRegistry<PtySubscribeFrame>;
  /** Predicate: is `ptyId` currently a known session?
   *  Production: backed by the session table (lifecycle layer).
   *  Tests: typically `(id) => id === 'pty-test'`. */
  readonly isValidPtyId: (ptyId: string) => boolean;
  /** Optional logger for diagnostic events. Defaults to a no-op so the
   *  handler stays transport-clean. The daemon shell wires a pino child. */
  readonly log?: {
    debug?: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/** Map a registry `DrainReason` to the handler's end-reason vocabulary. */
function drainReasonToEndReason(r: DrainReason): PtySubscribeEndReason {
  // Direct 1:1 mapping — both vocabularies were authored against
  // §3.5.1.5 / §3.5.1.2 so they line up by construction.
  switch (r.kind) {
    case 'pty-exit':
      return r.detail !== undefined
        ? { kind: 'pty-exit', detail: r.detail }
        : { kind: 'pty-exit' };
    case 'pty-crashed':
      return r.detail !== undefined
        ? { kind: 'pty-crashed', detail: r.detail }
        : { kind: 'pty-crashed' };
    case 'daemon-shutdown':
      return r.detail !== undefined
        ? { kind: 'daemon-shutdown', detail: r.detail }
        : { kind: 'daemon-shutdown' };
    case 'session-removed':
      return r.detail !== undefined
        ? { kind: 'session-removed', detail: r.detail }
        : { kind: 'session-removed' };
  }
}

/** Lightweight runtime check that the request payload carries a usable
 *  `ptyId`. The envelope adapter (T5 TypeBox) does the real schema
 *  validation; this is a defensive last-line check so the handler can
 *  produce a typed end-reason instead of throwing. */
function readPtyId(req: unknown): { ok: true; ptyId: string } | { ok: false; detail: string } {
  if (typeof req !== 'object' || req === null) {
    return { ok: false, detail: 'request payload is not an object' };
  }
  const raw = (req as { readonly ptyId?: unknown }).ptyId;
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, detail: 'request.ptyId must be a non-empty string' };
  }
  return { ok: true, ptyId: raw };
}

/**
 * Handle one `pty.subscribe` streaming RPC.
 *
 * The transport calls `handlePtySubscribe(req, stream, ctx)` exactly
 * once per accepted streaming-init dispatch. The returned function is
 * the cancel hook: the transport invokes it when the caller disconnects
 * so the handler can unsubscribe from the registry and emit a final
 * `caller-cancel` end frame.
 *
 * Returns a no-op cancel hook if the request is invalid (the handler
 * already called `stream.end({ kind: 'invalid-*' })` synchronously).
 *
 * Pure modulo the registry side-effects: subscribe + (eventually)
 * unsubscribe.
 */
export function handlePtySubscribe(
  req: unknown,
  stream: PtySubscribeStream,
  ctx: PtySubscribeContext,
): () => void {
  const parsed = readPtyId(req);
  if (!parsed.ok) {
    stream.end({ kind: 'invalid-request', detail: parsed.detail });
    return () => {
      /* nothing to unsubscribe */
    };
  }
  const ptyId = parsed.ptyId;

  if (!ctx.isValidPtyId(ptyId)) {
    stream.end({ kind: 'invalid-pty-id', ptyId });
    return () => {
      /* nothing to unsubscribe */
    };
  }

  // Idempotency guard: end() must be called at most once across all the
  // edges (registry close, caller cancel, double-cancel from transport).
  // The registry already tolerates double-unsubscribe; we replicate that
  // for the stream end-call.
  let ended = false;
  const endOnce = (reason: PtySubscribeEndReason): void => {
    if (ended) return;
    ended = true;
    try {
      stream.end(reason);
    } catch (err) {
      ctx.log?.debug?.(
        { err: err instanceof Error ? err.message : String(err), ptyId, reason },
        'pty_subscribe_end_threw',
      );
    }
  };

  const subscriber: Subscriber<PtySubscribeFrame> = {
    deliver(message) {
      // The producer side has already accounted for drop-slowest +
      // replay-burst exemption (see file header non-goals). Forward
      // verbatim.
      stream.push(message);
    },
    close(reason) {
      endOnce(drainReasonToEndReason(reason));
    },
  };

  const unsubscribe = ctx.registry.subscribe(ptyId, subscriber);

  ctx.log?.debug?.({ ptyId }, 'pty_subscribe_attached');

  // Cancel hook: caller disconnect path. Order matters — unsubscribe
  // first so a racing broadcast cannot deliver into a closed stream,
  // then end with the caller-cancel reason.
  return () => {
    unsubscribe();
    endOnce({ kind: 'caller-cancel' });
  };
}

/**
 * Adapter from the streaming handler shape to the dispatcher's unary
 * `Handler` signature. The dispatcher routes streaming RPCs via
 * `dispatchStreamingInit()` and the transport supplies the per-stream
 * `push`/`end`/`cancel` plumbing; the unary `Handler` we register here
 * is invoked only for in-band protocol probes (e.g. an envelope-shape
 * smoke that calls `dispatch('ccsm.v1/pty.subscribe', ...)` on the data
 * dispatcher to confirm the method is registered). On that path we
 * resolve immediately with `{ streaming: true }` so the dispatcher can
 * treat the call as routable.
 *
 * Real streaming flows do NOT go through this adapter — the transport
 * calls {@link handlePtySubscribe} directly with its own `stream`.
 */
export function makePtySubscribeHandler(_ctx: PtySubscribeContext): Handler {
  return async (_req: unknown, _dctx: DispatchContext): Promise<{ streaming: true }> => {
    // Unary fallback path: the data-plane dispatcher only knows whether
    // a method is registered; the streaming `push`/`end` channel is
    // owned by the transport. Returning a sentinel keeps `dispatch()`
    // (vs. `dispatchStreamingInit()`) honest for callers that probe.
    return { streaming: true };
  };
}

/**
 * One-liner registration helper. Registers
 * {@link PTY_SUBSCRIBE_METHOD} on the supplied data-plane dispatcher
 * and returns the streaming handler entry point so the transport can
 * wire it directly into its per-connection accept loop.
 *
 * Usage (daemon shell):
 *
 *   const { handle } = registerPtySubscribeHandler(dispatcher, ctx);
 *   transport.onStreamingRpc(PTY_SUBSCRIBE_METHOD, handle);
 *
 * The dispatcher registration is purely so `dispatchStreamingInit()`
 * recognises the method and replies with `ack_source: 'dispatcher'`
 * (the streaming-init ack); actual per-frame delivery is the
 * transport's responsibility via `handle(req, stream, ctx-bound)`.
 */
export function registerPtySubscribeHandler(
  dispatcher: Dispatcher,
  ctx: PtySubscribeContext,
): {
  readonly method: typeof PTY_SUBSCRIBE_METHOD;
  readonly handle: (req: unknown, stream: PtySubscribeStream) => () => void;
} {
  if (dispatcher.plane !== 'data') {
    throw new Error(
      `registerPtySubscribeHandler: refusing to register ${PTY_SUBSCRIBE_METHOD} on a ${dispatcher.plane}-plane dispatcher; pty.subscribe is a data-plane RPC (frag-3.4.1 §3.4.1.h)`,
    );
  }
  dispatcher.register(PTY_SUBSCRIBE_METHOD, makePtySubscribeHandler(ctx));
  return {
    method: PTY_SUBSCRIBE_METHOD,
    handle: (req, stream) => handlePtySubscribe(req, stream, ctx),
  };
}
