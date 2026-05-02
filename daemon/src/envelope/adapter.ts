// Daemon-side envelope adapter (B7a — Task #28).
//
// Bridges raw Duplex sockets (control-socket / data-socket transports) to the
// pure {@link Dispatcher} via length-prefixed JSON envelope framing per spec
// frag-3.4.1 §3.4.1.a (frame-version nibble + 16 MiB cap), §3.4.1.c (header
// + payload split), §3.4.1.d (schema validation hook = JSON-parse + minimum
// routing-field shape check).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.a frame-header parsing order (already enforced by `decodeFrame`).
//     §3.4.1.a oversize rejection sequence: warn -> write synthetic
//                `{ id: 0, error: { code: "envelope_too_large", ... } }` reply
//                (best-effort) -> `socket.destroy()`.
//     §3.4.1.c header schema (`id` + `method` + `payloadType` + `payloadLen`).
//     §3.4.1.d malformed/unknown-shape header -> `{ id, error: { code:
//                "schema_violation" } }` -> `socket.destroy()`.
//   - PR-context: scope is the wire-up gap noted in `daemon/src/index.ts`
//     (lines ~270-305) "Envelope adapter wiring is T-future". This adapter is
//     that wiring. It is intentionally MINIMAL: it owns framing + dispatch +
//     reply; the dispatcher (`daemon/src/dispatcher.ts`) owns method routing,
//     and the per-handler / per-interceptor work (HMAC, deadline, hello-gate,
//     migration-gate, trace-id fan-out) is composed into the dispatcher by
//     other tasks. This module knows nothing about those.
//
// Single Responsibility (producer / decider / sink, per dev contract §2):
//   - PRODUCER: socket `data` events. Accumulates bytes in a per-connection
//     buffer until at least one full frame is available.
//   - DECIDER: `decodeFrame` (pure) + `JSON.parse(headerJson)` + minimum
//     routing-field validation. Decides the frame is well-formed enough to
//     dispatch; otherwise emits the appropriate error envelope.
//   - SINK: writes the reply envelope back to the socket (`socket.write`).
//     Never mutates dispatcher state, never owns timers.
//
// What this module deliberately does NOT do (out of scope per Task #28):
//   - Binary trailer round-trip in either direction. Reply payload is JSON-
//     only in v0.3.x today (no daemon->client handler returns binary). The
//     decode side preserves the trailer Buffer and forwards it to handlers via
//     `req.payload` so a future binary handler can consume it; reply encoding
//     stays pure-JSON. When binary replies arrive we'll extend `writeReply` —
//     no rework on this side.
//   - HMAC handshake / hello-gate / migration-gate / interceptor pipeline.
//     Those are layered into the dispatcher by their own modules
//     (`hello-interceptor.ts`, `migration-gate-interceptor.ts`,
//     `deadline-interceptor.ts`, `hmac.ts`).
//   - Per-stream chunking, fan-out caching, header-skeleton fast path
//     (§3.4.1.b / §3.4.1.c hot-path optimizations). All v0.4-relevant; v0.3
//     unblocks #27 (Electron envelope migration) without these.
//   - Connect-RPC / HTTP/2. Lives in `connect/server.ts`; wholly separate
//     transport.

import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';

import { decodeFrame, encodeFrame, EnvelopeError, ENVELOPE_LIMITS } from './envelope.js';
import type { Dispatcher, DispatchContext } from '../dispatcher.js';
import {
  buildReplyHeaders,
  dispatchWithInterceptors,
  type ChainConnectionState,
  type ChainWiring,
} from './interceptor-chain.js';
import { createHelloState } from './hello-interceptor.js';

// ---------------------------------------------------------------------------
// Inbound header shape (minimum routing fields — §3.4.1.c subset)
// ---------------------------------------------------------------------------

/**
 * Minimum-shape inbound envelope header, post-`JSON.parse`. The full spec
 * §3.4.1.c shape includes `payloadType`, `payloadLen`, `stream`, `traceId`,
 * `headers` etc.; the adapter only inspects fields it needs to route and
 * reply. Unknown fields are forwarded to the dispatcher untouched (handlers
 * own per-method validation, §3.4.1.d).
 */
interface InboundHeader {
  /** RPC id; non-negative integer. `0` is reserved for synthetic error replies
   *  emitted by the adapter (per §3.4.1.a oversize-reply rule). */
  id: number;
  /** RPC method name (literal — see §3.4.1.h literal-vs-namespace lock). */
  method: string;
  /** Optional Crockford ULID; the dispatcher / handlers may consume it. The
   *  adapter does NOT validate the ULID regex (that's the trace-id interceptor
   *  per §3.4.1.c round-3 CC-2). */
  traceId?: string;
}

/** Minimal type guard for the routing fields above. Returns `false` for any
 *  non-object, missing `id`/`method`, or wrong-typed fields — those become
 *  `schema_violation` per §3.4.1.d. */
function isWellFormedHeader(v: unknown): v is InboundHeader {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id < 0) return false;
  if (typeof o.method !== 'string' || o.method.length === 0) return false;
  if (o.traceId !== undefined && typeof o.traceId !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reply envelope helpers
// ---------------------------------------------------------------------------

/** Build a `{ id, ok: true, value }` reply. Pure-JSON header, empty trailer.
 *
 *  When `headers` is supplied (#153 N13-fix), the reserved-header block is
 *  spliced into the reply envelope so the client can read the
 *  `x-ccsm-daemon-trace-id` join id. Empty `headers` is omitted to keep
 *  legacy reply bytes identical for callers that don't care. */
function encodeOkReply(
  id: number,
  value: unknown,
  ackSource: 'handler' | 'dispatcher',
  headers?: Record<string, string>,
): Buffer {
  const header: Record<string, unknown> = {
    id,
    ok: true as const,
    value,
    ack_source: ackSource,
    payloadType: 'json' as const,
    payloadLen: 0,
  };
  if (headers && Object.keys(headers).length > 0) {
    header['headers'] = headers;
  }
  return encodeFrame({
    headerJson: Buffer.from(JSON.stringify(header), 'utf8'),
  });
}

/** Build a `{ id, ok: false, error: { code, message } }` reply. */
function encodeErrorReply(
  id: number,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
  headers?: Record<string, string>,
): Buffer {
  const error: Record<string, unknown> = { code, message };
  if (extras) {
    for (const [k, v] of Object.entries(extras)) error[k] = v;
  }
  const header: Record<string, unknown> = {
    id,
    ok: false as const,
    error,
    payloadType: 'json' as const,
    payloadLen: 0,
  };
  if (headers && Object.keys(headers).length > 0) {
    header['headers'] = headers;
  }
  return encodeFrame({
    headerJson: Buffer.from(JSON.stringify(header), 'utf8'),
  });
}

// ---------------------------------------------------------------------------
// Adapter mount surface
// ---------------------------------------------------------------------------

/**
 * Logger surface used by the adapter for forensic warn lines. Mirrors the
 * shape `data-socket.ts` / `control-socket.ts` already accept so callers can
 * pass the same pino child.
 */
export interface AdapterLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MountEnvelopeAdapterOptions {
  /** Pre-accepted Duplex socket (one per connection). Adapter takes ownership
   *  of the `data` / `error` / `close` listeners; caller MUST NOT register
   *  competing parsers. */
  readonly socket: Duplex;
  /** Pure dispatcher (supervisor-plane on control-socket, data-plane on
   *  data-socket). The adapter calls `dispatcher.dispatch(method, value, ctx)`
   *  per inbound frame. */
  readonly dispatcher: Pick<Dispatcher, 'dispatch'>;
  /** Best-effort warn sink. Defaults to a `console.warn` adapter so the
   *  module works in tests without the daemon's pino child. */
  readonly logger?: AdapterLogger;
  /** Optional forensic peer-pid (from §3.1.1 peer-cred lookup) for the
   *  `envelope_oversize` warn line per §3.4.1.a. */
  readonly peerPid?: number;
  /** Optional forensic peer label (e.g. `'control-socket'` / `'data-socket'`)
   *  for log correlation. */
  readonly peer?: string;
  /**
   * Interceptor-chain wiring (#153 N13-fix). Optional: when omitted, the
   * adapter constructs a minimal chain that still mints `daemonTraceId` and
   * echoes it on the reply, but skips hello / deadline / migrationGate /
   * metrics. This preserves backward compatibility with existing callers
   * that pass only `{ socket, dispatcher }` while making the dual-id
   * correlation property unconditional.
   *
   * Pass `chainWiring: { ...wiring }` (without `dispatcher`, which the
   * adapter splices in from `opts.dispatcher`) to engage the full pipeline.
   * Per-connection state (`helloState`) is constructed by the adapter at
   * mount time; callers do NOT manage it directly.
   */
  readonly chainWiring?: Omit<ChainWiring, 'dispatcher'>;
}

/**
 * Mount the envelope adapter onto a freshly-accepted socket. Returns nothing —
 * the adapter installs its own listeners and lives until the socket closes.
 *
 * Behavior summary:
 *   - Accumulates inbound bytes; loops `decodeFrame` until the buffer is short
 *     of a full frame (truncated reads are normal — wait for more data).
 *   - On any other `EnvelopeError` (oversize, unsupported version, corrupt
 *     headerLen): warn + best-effort error reply with `id: 0` + destroy.
 *   - On malformed JSON header (`JSON.parse` throws): warn + `schema_violation`
 *     reply (best-effort, `id: 0` because we cannot trust any field) + destroy.
 *   - On a well-formed header that fails `isWellFormedHeader`: warn +
 *     `schema_violation` reply + destroy.
 *   - On a well-formed header: dispatch to `dispatcher.dispatch(method, value,
 *     ctx)`. The `value` forwarded to handlers is the parsed header itself
 *     (JSON-frame mode) or `{ ...header, payload }` (binary-frame mode — the
 *     trailer is exposed as `payload` so a future binary handler can consume
 *     it). Reply encoded as `{ id, ok, value | error }`.
 */
export function mountEnvelopeAdapter(opts: MountEnvelopeAdapterOptions): void {
  const { socket, dispatcher, peerPid, peer } = opts;
  const logger = opts.logger ?? defaultLogger();

  // Per-connection interceptor-chain state (#153 N13-fix). Always constructed
  // so the chain has somewhere to mutate; when the caller did not supply a
  // helloConfig the hello slot is a no-op pass-through and this state stays
  // unused. Constructing it unconditionally avoids a branch in the hot path.
  const chainState: ChainConnectionState = { helloState: createHelloState() };
  // Splice the dispatcher into the wiring (caller passes it via `opts.dispatcher`,
  // not via `chainWiring`, so the two surfaces stay decoupled).
  const chainWiring: ChainWiring | undefined = opts.chainWiring
    ? { ...opts.chainWiring, dispatcher }
    : undefined;

  // Per-connection buffer accumulator. We use Buffer.concat over a small array
  // so a slow trickle of 1-byte writes does not become quadratic; for v0.3
  // dogfood load (<= a few subscribers) this is comfortably within budget.
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let destroyed = false;

  function destroy(reason: string, extras?: Record<string, unknown>): void {
    if (destroyed) return;
    destroyed = true;
    logger.warn(
      { event: 'envelope-adapter.destroy', reason, peer, peerPid, ...(extras ?? {}) },
      `envelope adapter destroying socket: ${reason}`,
    );
    try {
      socket.destroy();
    } catch {
      // best-effort
    }
  }

  function tryWrite(buf: Buffer): void {
    // Best-effort reply per §3.4.1.a — never throw out of the adapter on a
    // half-closed write. The `socket.destroy()` that follows is the
    // authoritative cleanup; this write is an *advisory* error frame.
    try {
      socket.write(buf);
    } catch {
      // swallow — the socket is already going away
    }
  }

  function processBuffer(): void {
    // Loop until the buffer is too short for a full frame OR we destroy.
    while (!destroyed && pendingBytes >= ENVELOPE_LIMITS.PREFIX_LEN) {
      const head = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
      // Re-coalesce the pending list to a single chunk for slicing.
      if (pending.length !== 1) {
        pending.length = 0;
        pending.push(head);
      }

      let decoded: ReturnType<typeof decodeFrame>;
      try {
        decoded = decodeFrame(head);
      } catch (err) {
        if (err instanceof EnvelopeError) {
          if (err.code === 'truncated_frame') {
            // Wait for more bytes — this is the happy "partial read" path.
            return;
          }
          // Oversize / unsupported nibble / corrupt header length — synthetic
          // reply per §3.4.1.a then destroy. Reply MUST use id: 0 because we
          // cannot trust any header field on a frame we couldn't decode.
          if (err.code === 'envelope_too_large') {
            logger.warn(
              { event: 'envelope-adapter.envelope_oversize', peer, peerPid, len: err.len },
              'envelope_oversize',
            );
          }
          tryWrite(
            encodeErrorReply(
              0,
              err.code,
              err.message,
              err.nibble !== undefined ? { nibble: err.nibble } : undefined,
            ),
          );
          destroy(err.code, { len: err.len, nibble: err.nibble });
          return;
        }
        // Unknown decode error — fail closed.
        destroy('decode_threw', { err: String(err) });
        return;
      }

      // Compute total bytes consumed by this frame: 4-byte prefix +
      // 2-byte headerLen field + headerJson + payload.
      const frameLen =
        ENVELOPE_LIMITS.PREFIX_LEN +
        ENVELOPE_LIMITS.HEADER_LEN_FIELD +
        decoded.headerJson.length +
        decoded.payload.length;

      // Slice the consumed bytes off `head` and keep the remainder for the
      // next iteration. Subarray is zero-copy; we only allocate when the next
      // `data` event arrives and we re-coalesce.
      if (frameLen >= head.length) {
        pending.length = 0;
        pendingBytes = 0;
      } else {
        const remainder = head.subarray(frameLen);
        pending.length = 0;
        pending.push(remainder);
        pendingBytes = remainder.length;
      }

      // Parse + validate header. Either failure -> schema_violation + destroy.
      let headerObj: unknown;
      try {
        headerObj = JSON.parse(decoded.headerJson.toString('utf8'));
      } catch {
        tryWrite(encodeErrorReply(0, 'schema_violation', 'malformed JSON header'));
        destroy('schema_violation_parse');
        return;
      }
      if (!isWellFormedHeader(headerObj)) {
        // We may know `id` if it parsed but failed shape — best-effort echo.
        const maybeId =
          headerObj && typeof headerObj === 'object' && typeof (headerObj as { id?: unknown }).id === 'number'
            ? (headerObj as { id: number }).id
            : 0;
        tryWrite(
          encodeErrorReply(maybeId, 'schema_violation', 'header missing required routing fields'),
        );
        destroy('schema_violation_shape');
        return;
      }

      // Dispatch. `value` forwarded to handlers includes the trailer when
      // present so a future binary handler can consume it; the dispatcher
      // itself treats it as opaque.
      const requestValue: unknown =
        decoded.payload.length > 0 ? { ...headerObj, payload: decoded.payload } : headerObj;

      const ctx: DispatchContext =
        headerObj.traceId !== undefined ? { traceId: headerObj.traceId } : {};

      const id = headerObj.id;
      const method = headerObj.method;

      // ---- Chain path (#153 N13-fix) ----
      // When the caller wired a chain, route every envelope through the
      // 5-interceptor pipeline (hello → trace → deadline → migrationGate →
      // dispatcher → metrics). The chain itself NEVER throws and always
      // surfaces a daemonTraceId for the reply trailer. socketFatal codes
      // (`hello_required`, `hello_replay`, etc.) trigger destroy-after-write
      // per spec §3.4.1.g.
      if (chainWiring) {
        const headersForChain: Record<string, string | number> = {};
        const rawHeaders = (headerObj as { headers?: unknown }).headers;
        if (rawHeaders && typeof rawHeaders === 'object') {
          for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
            if (typeof v === 'string' || typeof v === 'number') {
              headersForChain[k.toLowerCase()] = v;
            }
          }
        }
        void dispatchWithInterceptors(
          {
            id,
            method,
            traceId: headerObj.traceId,
            headers: headersForChain,
            payload: requestValue,
          },
          chainState,
          chainWiring,
        ).then((reply) => {
          if (destroyed) return;
          const replyHeaders = buildReplyHeaders(reply);
          if (reply.kind === 'ok') {
            tryWrite(encodeOkReply(reply.id, reply.value, reply.ackSource, replyHeaders));
          } else {
            tryWrite(
              encodeErrorReply(reply.id, reply.code, reply.message, reply.extras, replyHeaders),
            );
            if (reply.socketFatal) {
              destroy(reply.code, { method });
            }
          }
        });
        continue;
      }

      // ---- Legacy direct-dispatch path (no chain wired) ----
      // Fire-and-forget — handlers may take time. Per spec §3.4.1.b unary
      // frames may interleave between sub-chunks, so per-connection FIFO is
      // NOT required for correctness. Dispatch async and let promises race.
      void dispatcher.dispatch(method, requestValue, ctx).then(
        (result) => {
          if (destroyed) return;
          if (result.ok) {
            tryWrite(encodeOkReply(id, result.value, result.ack_source));
          } else {
            tryWrite(
              encodeErrorReply(id, result.error.code, result.error.message, {
                method: result.error.method,
              }),
            );
          }
        },
        (err: unknown) => {
          if (destroyed) return;
          // Handler threw (non-stub). Surface as INTERNAL — handlers SHOULD
          // throw typed errors but we cannot guarantee discipline at this
          // boundary. The synthetic reply lets the caller fail their RPC
          // promise instead of timing out.
          tryWrite(encodeErrorReply(id, 'INTERNAL', String(err)));
          logger.warn(
            { event: 'envelope-adapter.handler_threw', peer, peerPid, method, err: String(err) },
            'handler threw outside the dispatcher contract',
          );
        },
      );
    }
  }

  socket.on('data', (chunk: Buffer) => {
    if (destroyed) return;
    pending.push(chunk);
    pendingBytes += chunk.length;
    processBuffer();
  });

  socket.on('error', (err: Error) => {
    // Surface but do not throw out — caller may have its own listener.
    logger.warn(
      { event: 'envelope-adapter.socket_error', peer, peerPid, err: String(err) },
      'socket error',
    );
  });

  socket.on('close', () => {
    destroyed = true;
    pending.length = 0;
    pendingBytes = 0;
  });
}

function defaultLogger(): AdapterLogger {
  return {
    warn: (obj, msg) => {
      console.warn(`${msg} ${JSON.stringify(obj)}`);
    },
  };
}
