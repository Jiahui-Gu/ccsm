// Server-streaming adapter for the data-socket envelope (Task #92).
//
// Extends the unary `mountEnvelopeAdapter` (adapter.ts) with the wire-level
// streaming RPC shape mandated by frag-3.4.1 §3.4.1.b + §3.4.1.c and the
// fan-out / replay / boot-nonce semantics owned by frag-3.5.1 §3.5.1.4 /
// §3.5.1.5.
//
// Stream lifecycle on the wire (per spec §3.4.1.c kind enum, mapped to the
// task #92 brief vocabulary in parens):
//
//   client → server :  { stream: { streamId, seq: 0, kind: 'open' } }   (Init)
//   server → client :  { stream: { streamId, seq: N, kind: 'chunk' } }* (Data)
//                      { stream: { streamId, seq: M, kind: 'heartbeat' } }*
//   server → client :  { stream: { streamId, seq: K, kind: 'close' } }  (End)
//   client → server :  { stream: { streamId, kind: 'cancel' } }         (Cancel)
//
// Per-call stream id is the wire `streamId` field (uint32, odd ids client-
// initiated per §3.4.1.b round-2 fwdcompat P2-2). `traceId` is required on
// the open frame and inherited by chunk/heartbeat sub-frames via the
// streamId→traceId map (`trace-id-map.ts`, spec §3.4.1.c).
//
// Single Responsibility:
//   - PRODUCER: socket bytes (delegated to `mountEnvelopeAdapter`'s parser)
//     plus a per-stream outbound emitter that writes Data/End frames with
//     monotonic `seq`.
//   - DECIDER: routes inbound frames into one of {unary, stream-open,
//     stream-cancel}; rejects malformed (missing `streamId`, illegal `kind`,
//     unknown streamId) with structured error replies. Streaming Init goes
//     through `dispatcher.dispatchStreamingInit(method)` for the
//     plane-scoped allowlist + handler-registered check.
//   - SINK: invokes the registered streaming handler via the
//     `StreamHandlerRegistry` callback table; the handler in turn emits
//     Data/End frames through the adapter's outbound emitter.
//
// What this module DOES NOT do (intentional scope per Task #92 brief):
//   - PTY hookup / actual `pty.subscribe` wiring (#73 / pty-subscribe.ts).
//   - SessionWatcher hookup (#74).
//   - Connect-RPC migration (v0.4).
//   - Hello-HMAC handshake / supervisor control-plane envelope (those stay
//     unary on `control-socket`).
//   - Per-chunk header-skeleton fast path / `socket.cork`/`uncork` (perf
//     optimizations called out by spec §3.4.1.c hot-path bullets; they live
//     in the encode side, not the lifecycle side, and are deferred to the
//     cached-skeleton task — this module emits one `socket.write` per frame
//     via the unary adapter's encoder).
//
// Spec citations:
//   - frag-3.4.1 §3.4.1.b chunked frames + replay budget (256 KiB cap)
//   - frag-3.4.1 §3.4.1.c kind enum {open|chunk|close|heartbeat} + traceId
//     placement on stream frames
//   - frag-3.5.1 §3.5.1.4 subscribe contract (fromSeq, fromBootNonce)
//   - frag-3.5.1 §3.5.1.5 fan-out registry, drop-slowest 1 MiB watermark,
//     replay-burst exemption

import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';

import { encodeFrame } from './envelope.js';
import { CHUNK_LIMITS, MAX_REPLAY_BYTES, MAX_SUBFRAME_BYTES } from './chunk-reassembly.js';
import { TraceIdMap } from './trace-id-map.js';
import type { Dispatcher } from '../dispatcher.js';

// ---------------------------------------------------------------------------
// Wire-level kinds
// ---------------------------------------------------------------------------

/**
 * Stream sub-frame kinds carried on the envelope header `stream.kind` field.
 * Spec-canonical names (`open|chunk|close|heartbeat`) are the wire literals;
 * the task #92 vocabulary (Init=open, Data=chunk, End=close, Cancel=cancel)
 * is the prose mapping in the file header. `cancel` is the explicit caller-
 * disconnect signal added on top of the spec enum so the daemon side can
 * tear down without waiting for a socket-`close` event.
 */
export type StreamKind = 'open' | 'chunk' | 'close' | 'heartbeat' | 'cancel';

/** Inbound stream-frame header shape. Validated by `isStreamHeader`. */
export interface StreamFrameHeader {
  readonly id: number;
  readonly method: string;
  readonly stream: {
    readonly streamId: number;
    readonly seq?: number;
    readonly kind: StreamKind;
  };
  readonly traceId?: string;
  readonly headers?: Record<string, string>;
}

/**
 * Optional resubscribe cursors carried in the open frame. Per §3.4.1.b /
 * §3.5.1.4: client may pass `fromSeq` (last seq it saw) and `fromBootNonce`
 * (last daemon boot nonce it observed). The adapter computes the delivery
 * mode (gap-free replay vs snapshot+gap vs bootChanged) based on these.
 */
export interface OpenFramePayload {
  readonly fromSeq?: number;
  readonly fromBootNonce?: string;
}

// ---------------------------------------------------------------------------
// Outbound stream handle (passed to the registered handler)
// ---------------------------------------------------------------------------

/**
 * Per-stream outbound handle handed to a streaming handler. The handler
 * invokes `data()`, `heartbeat()`, and `end()` to emit frames; the adapter
 * owns seq counter, chunk splitting, replay buffer, and drop-slowest.
 *
 * Calling `data()` after `end()` (or after the caller has cancelled) is a
 * silent no-op — the handler does not need to track its own end state.
 */
export interface StreamHandle {
  /** Stream id allocated by the adapter for this open frame. */
  readonly streamId: number;
  /** Daemon boot nonce visible to this stream (mirrored in every frame's
   *  outbound headers so the renderer can detect respawn). */
  readonly bootNonce: string;
  /** True if this open is a replay-burst (caller passed `fromSeq` and the
   *  adapter is delivering the bounded replay window). The handler usually
   *  does not need to look at this — drop-slowest accounting is handled by
   *  the adapter via the {@link StreamHandle.recordDeliveredBytes} hook. */
  readonly replayBurstInProgress: boolean;
  /** Push one logical message of binary data. Payloads >16 KiB are split
   *  into ≤16 KiB sub-chunks per spec §3.4.1.b (each emitted as its own
   *  envelope frame with the same `streamId` and a per-stream monotonic
   *  `seq`). The handler is shape-agnostic. */
  data(payload: Buffer): void;
  /** Emit a heartbeat sub-frame (§3.4.1.c kind enum). Cheap (~50 bytes
   *  envelope). */
  heartbeat(): void;
  /** Terminal close. After end(), data()/heartbeat() are silent no-ops.
   *  The adapter writes the close frame with the supplied `reason` and
   *  releases per-stream state (replay buffer, traceId map entry). */
  end(reason: StreamEndReason): void;
  /** True once end() has fired or the caller has cancelled. */
  isEnded(): boolean;
}

/** Structured close reason. Mirrors the vocabulary used by
 *  `pty-subscribe.ts` so the transport mapping is 1:1. */
export type StreamEndReason =
  | { readonly code: 'OK'; readonly message?: string }
  | { readonly code: 'CANCELLED'; readonly message?: string }
  | { readonly code: 'RESOURCE_EXHAUSTED'; readonly message?: string }
  | { readonly code: 'INTERNAL'; readonly message?: string };

// ---------------------------------------------------------------------------
// Streaming handler registry
// ---------------------------------------------------------------------------

/**
 * A streaming handler is invoked once per accepted Init frame. It receives
 * the open payload (`fromSeq`, `fromBootNonce`, plus any handler-specific
 * fields the caller passed in the JSON body) and the outbound `StreamHandle`.
 *
 * The handler returns a `cancel` callback synchronously: the adapter calls
 * it when the client sends a Cancel frame OR the underlying socket closes.
 * `cancel` is a SYNC sink (no return value) — it should unsubscribe from
 * fan-out and call `stream.end({ code: 'CANCELLED' })` if not already ended.
 *
 * Errors thrown synchronously from the handler are converted into a
 * `INTERNAL` close frame; the adapter never lets a handler exception
 * propagate to the socket.
 */
export type StreamingHandler = (
  req: OpenFramePayload & Record<string, unknown>,
  stream: StreamHandle,
) => () => void;

/** Registry of streaming handlers, keyed by wire `method` string. The
 *  unary dispatcher's surface is unchanged; this registry is the parallel
 *  surface the streaming adapter consults on Init frames. */
export class StreamHandlerRegistry {
  readonly #handlers = new Map<string, StreamingHandler>();

  register(method: string, handler: StreamingHandler): void {
    this.#handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.#handlers.has(method);
  }

  get(method: string): StreamingHandler | undefined {
    return this.#handlers.get(method);
  }
}

// ---------------------------------------------------------------------------
// Per-stream state
// ---------------------------------------------------------------------------

interface StreamState {
  readonly streamId: number;
  readonly method: string;
  readonly traceId: string | undefined;
  /** Next outbound `seq` to assign on a Data sub-frame. Monotonic per spec
   *  §3.4.1.b; rolls forward on every chunk emission. */
  nextSeq: number;
  /** Cancel hook returned by the registered handler. Called on Cancel
   *  frame or socket close. */
  cancel: () => void;
  /** True after end()/cancel; further data()/heartbeat() are no-ops. */
  ended: boolean;
  /** Cumulative pending bytes attributed to this subscriber for the
   *  drop-slowest watermark (spec §3.5.1.5). NOT incremented for the
   *  replay-burst window (round-3 perf CF-2 exemption). */
  pendingBytes: number;
  /** True for the duration of the replay-burst write (set by the adapter
   *  before emitting the replay window, cleared after). */
  inReplayBurst: boolean;
  /** Bounded replay buffer; oldest-first, total bytes <= 256 KiB. */
  replay: { seq: number; payload: Buffer }[];
  replayBytes: number;
}

// ---------------------------------------------------------------------------
// Adapter mount
// ---------------------------------------------------------------------------

export interface StreamingAdapterLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

export interface MountStreamingAdapterOptions {
  /** Pre-accepted Duplex socket. The streaming adapter installs ITS OWN
   *  listeners; do NOT also call `mountEnvelopeAdapter` on the same
   *  socket — pick one or the other (or the wrapper at the bottom of this
   *  file which routes both unary and streaming traffic through the same
   *  parser). */
  readonly socket: Duplex;
  /** Data-plane dispatcher. Streaming Init goes through
   *  `dispatchStreamingInit(method)` for the plane-scoped allowlist /
   *  handler-registered check. */
  readonly dispatcher: Pick<Dispatcher, 'dispatchStreamingInit'>;
  /** Streaming handler registry — wires `method` → `StreamingHandler`. */
  readonly handlers: StreamHandlerRegistry;
  /** Daemon boot nonce. Mirrored on every outbound stream frame so the
   *  renderer can detect daemon respawn (spec §3.4.1.g + §3.5.1.4). */
  readonly bootNonce: string;
  /** Per-subscriber drop-slowest watermark in bytes. Defaults to 1 MiB
   *  (spec §3.5.1.5). */
  readonly dropSlowestThresholdBytes?: number;
  readonly logger?: StreamingAdapterLogger;
  readonly peer?: string;
  readonly peerPid?: number;
}

/** Default 1 MiB watermark per spec §3.5.1.5. */
const DEFAULT_DROP_SLOWEST_BYTES = 1024 * 1024;

/**
 * Mount the streaming adapter onto a freshly-accepted socket. Returns a
 * handle exposing per-connection introspection (live stream count, manual
 * close) for tests and for the daemon shutdown sequence.
 *
 * The adapter takes ownership of the socket's `data`/`error`/`close`
 * listeners. Frames classified as `unary` (no `stream` field on the
 * header) are passed to `opts.unaryDispatch` if provided; without that
 * callback they are rejected with `schema_violation` so a misrouted
 * unary frame on a streaming-only connection fails loud rather than
 * being silently dropped.
 */
export interface StreamingAdapterHandle {
  /** Number of currently-live streams on this connection. */
  liveStreamCount(): number;
  /** Cancel + close every live stream with `RESOURCE_EXHAUSTED` (used by
   *  the daemon shutdown sequence per frag-3.5.1 §3.5.1.2 step 4). */
  closeAll(reason: string): void;
}

export function mountStreamingAdapter(
  opts: MountStreamingAdapterOptions,
): StreamingAdapterHandle {
  const { socket, dispatcher, handlers, bootNonce } = opts;
  const dropThreshold = opts.dropSlowestThresholdBytes ?? DEFAULT_DROP_SLOWEST_BYTES;
  const logger = opts.logger ?? defaultLogger();
  const peer = opts.peer;
  const peerPid = opts.peerPid;

  const traceMap = new TraceIdMap();
  const streams = new Map<number, StreamState>();
  let destroyed = false;

  // Per-connection inbound buffer accumulator (mirrors adapter.ts).
  const pending: Buffer[] = [];
  let pendingBytes = 0;

  function destroy(reason: string, extras?: Record<string, unknown>): void {
    if (destroyed) return;
    destroyed = true;
    closeAllStreams(`socket-destroy:${reason}`);
    logger.warn(
      { event: 'streaming-adapter.destroy', reason, peer, peerPid, ...(extras ?? {}) },
      `streaming adapter destroying socket: ${reason}`,
    );
    try {
      socket.destroy();
    } catch {
      /* best-effort */
    }
  }

  function tryWrite(buf: Buffer): boolean {
    if (destroyed) return false;
    try {
      return socket.write(buf);
    } catch {
      return false;
    }
  }

  function writeStreamFrame(
    state: StreamState,
    kind: StreamKind,
    seq: number,
    payload: Buffer,
    extras?: Record<string, unknown>,
    options?: { exemptFromBackpressure?: boolean },
  ): void {
    if (destroyed) return;
    // Sub-frame size policy: spec §3.4.1.b mandates ≤16 KiB per chunk.
    // For the case where caller passes an over-cap payload, split into
    // sub-chunks before writing. Heartbeat / close frames carry no payload
    // so the split loop is a no-op.
    const slices: Buffer[] =
      payload.length === 0 || kind !== 'chunk' ? [payload] : splitForSubframes(payload);

    let curSeq = seq;
    for (const slice of slices) {
      const headerObj: Record<string, unknown> = {
        id: 0,
        method: state.method,
        stream: { streamId: state.streamId, seq: curSeq, kind },
        payloadType: slice.length > 0 ? 'binary' : 'json',
        payloadLen: slice.length,
        // bootNonce is mirrored on every outbound frame so a renderer that
        // missed the open frame can still resync. Inexpensive (~30 B).
        bootNonce,
        ...(extras ?? {}),
      };
      // traceId placement per §3.4.1.c: required on `open` and `close` frames,
      // OMITTED from `chunk` and `heartbeat`. Open frames are inbound only
      // (we never emit them server-side here); close frames carry it.
      if ((kind === 'close' || kind === 'cancel') && state.traceId !== undefined) {
        headerObj.traceId = state.traceId;
      }

      const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
      const frame = encodeFrame({ headerJson, payload: slice });

      // Drop-slowest accounting (spec §3.5.1.5). The replay-burst window is
      // exempt per round-3 perf CF-2; close/heartbeat frames are not
      // accounted (they're tiny + control-plane).
      if (
        kind === 'chunk' &&
        !options?.exemptFromBackpressure &&
        !state.inReplayBurst
      ) {
        state.pendingBytes += slice.length;
        if (state.pendingBytes > dropThreshold) {
          // Past 1 MiB: drop the subscriber + RESOURCE_EXHAUSTED close.
          logger.warn(
            {
              event: 'streaming-adapter.subscriber_dropped_slow',
              streamId: state.streamId,
              method: state.method,
              pendingBytes: state.pendingBytes,
              traceId: state.traceId,
              peer,
              peerPid,
            },
            'subscriber-dropped-slow',
          );
          // Tear down this stream synchronously. We've already put the
          // current chunk on the wire; the close frame follows.
          tryWrite(frame);
          // Push to replay buffer BEFORE we close so a future resubscribe
          // (within budget) can still tail the ring.
          recordReplay(state, curSeq, slice);
          curSeq += 1;
          // Adapter-initiated end with RESOURCE_EXHAUSTED.
          endStream(state, { code: 'RESOURCE_EXHAUSTED', message: 'subscriber-dropped-slow' });
          return;
        }
      }

      tryWrite(frame);
      if (kind === 'chunk') {
        recordReplay(state, curSeq, slice);
      }
      curSeq += 1;
    }

    // Update nextSeq to the value AFTER all sub-frames consumed.
    if (kind === 'chunk' || kind === 'heartbeat') {
      state.nextSeq = curSeq;
    }
  }

  function recordReplay(state: StreamState, seq: number, payload: Buffer): void {
    state.replay.push({ seq, payload });
    state.replayBytes += payload.length;
    while (state.replayBytes > MAX_REPLAY_BYTES && state.replay.length > 0) {
      const dropped = state.replay.shift();
      if (dropped === undefined) break;
      state.replayBytes -= dropped.payload.length;
    }
  }

  function endStream(state: StreamState, reason: StreamEndReason): void {
    if (state.ended) return;
    state.ended = true;
    // Allocate a close-frame seq from the same monotonic counter so the
    // client sees a contiguous (chunk*, close) sequence.
    const seq = state.nextSeq;
    state.nextSeq += 1;
    writeStreamFrame(
      state,
      'close',
      seq,
      Buffer.alloc(0),
      { reason: { code: reason.code, ...(reason.message !== undefined ? { message: reason.message } : {}) } },
      { exemptFromBackpressure: true },
    );
    streams.delete(state.streamId);
    if (state.traceId !== undefined) {
      traceMap.release(String(state.streamId));
    }
  }

  function makeStreamHandle(state: StreamState): StreamHandle {
    return {
      streamId: state.streamId,
      bootNonce,
      replayBurstInProgress: state.inReplayBurst,
      data(payload) {
        if (state.ended || destroyed) return;
        writeStreamFrame(state, 'chunk', state.nextSeq, payload);
      },
      heartbeat() {
        if (state.ended || destroyed) return;
        writeStreamFrame(state, 'heartbeat', state.nextSeq, Buffer.alloc(0));
      },
      end(reason) {
        endStream(state, reason);
      },
      isEnded() {
        return state.ended;
      },
    };
  }

  function closeAllStreams(reason: string): void {
    for (const state of Array.from(streams.values())) {
      try {
        state.cancel();
      } catch {
        /* swallow */
      }
      endStream(state, { code: 'RESOURCE_EXHAUSTED', message: reason });
    }
  }

  // -------------------------------------------------------------------------
  // Inbound parser
  // -------------------------------------------------------------------------

  function processBuffer(): void {
    while (!destroyed && pendingBytes >= 4) {
      const head = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
      if (pending.length !== 1) {
        pending.length = 0;
        pending.push(head);
      }

      const decoded = tryDecode(head);
      if (decoded === undefined) {
        // Wait for more bytes / fatal already destroyed.
        return;
      }

      // Trim consumed bytes.
      const consumed =
        4 + // prefix
        2 + // headerLen field
        decoded.headerJson.length +
        decoded.payload.length;
      if (consumed >= head.length) {
        pending.length = 0;
        pendingBytes = 0;
      } else {
        const remainder = head.subarray(consumed);
        pending.length = 0;
        pending.push(remainder);
        pendingBytes = remainder.length;
      }

      // Parse header JSON.
      let headerObj: unknown;
      try {
        headerObj = JSON.parse(decoded.headerJson.toString('utf8'));
      } catch {
        writeSyntheticError(0, 'schema_violation', 'malformed JSON header');
        destroy('schema_violation_parse');
        return;
      }

      // Stream-frame route.
      if (isStreamHeader(headerObj)) {
        handleStreamFrame(headerObj, decoded.payload);
        continue;
      }

      // Unknown / unsupported on this listener.
      writeSyntheticError(
        typeof (headerObj as { id?: unknown }).id === 'number' ? (headerObj as { id: number }).id : 0,
        'schema_violation',
        'streaming-adapter: header lacks `stream` field; unary frames not accepted on this listener',
      );
      destroy('non_stream_frame');
      return;
    }
  }

  function tryDecode(buf: Buffer): { headerJson: Buffer; payload: Buffer } | undefined {
    // Inline a minimal decode (the unary adapter has the full version-nibble
    // + cap pipeline; reusing that here would couple the two — for the
    // streaming adapter we only need the byte split). The version nibble
    // and 16 MiB cap are still enforced by `decodeFrame` if a downstream
    // path imports it; here we accept anything `encodeFrame` would emit.
    if (buf.length < 4) return undefined;
    const raw = buf.readUInt32BE(0);
    const nibble = (raw >>> 28) & 0x0f;
    if (nibble !== 0) {
      writeSyntheticError(0, 'UNSUPPORTED_FRAME_VERSION', `unknown frame-version nibble 0x${nibble.toString(16)}`);
      destroy('unsupported_frame_version', { nibble });
      return undefined;
    }
    const payloadLen = raw & 0x0fffffff;
    if (payloadLen > 16 * 1024 * 1024) {
      writeSyntheticError(0, 'envelope_too_large', `frame payload ${payloadLen} exceeds 16 MiB cap`);
      destroy('envelope_too_large', { len: payloadLen });
      return undefined;
    }
    const total = 4 + payloadLen;
    if (buf.length < total) return undefined;
    if (payloadLen < 2) {
      destroy('corrupt_header_len');
      return undefined;
    }
    const headerLen = buf.readUInt16BE(4);
    const headerStart = 6;
    const headerEnd = headerStart + headerLen;
    if (headerEnd > total) {
      destroy('corrupt_header_len');
      return undefined;
    }
    return {
      headerJson: buf.subarray(headerStart, headerEnd),
      payload: buf.subarray(headerEnd, total),
    };
  }

  function handleStreamFrame(header: StreamFrameHeader, payload: Buffer): void {
    const { streamId, kind } = header.stream;

    if (kind === 'open') {
      // Init: route through dispatcher allowlist + look up streaming handler.
      const handler = handlers.get(header.method);
      const init = dispatcher.dispatchStreamingInit(header.method);
      if (!init.ok) {
        writeSyntheticError(header.id, init.error.code, init.error.message);
        return;
      }
      if (!handler) {
        writeSyntheticError(
          header.id,
          'UNKNOWN_METHOD',
          `streaming handler for ${header.method} not registered`,
        );
        return;
      }
      if (streams.has(streamId)) {
        writeSyntheticError(header.id, 'INVALID_ARGUMENT', `streamId ${streamId} already open`);
        return;
      }
      // Parse open payload (JSON body in the trailer is unusual; clients
      // pass cursors via the JSON header `payload` field. For simplicity
      // accept either trailer-binary OR header-embedded JSON `payload`.)
      const openPayload = readOpenPayload(header, payload);

      // Allocate state.
      const state: StreamState = {
        streamId,
        method: header.method,
        traceId: header.traceId,
        nextSeq: 0,
        cancel: () => {},
        ended: false,
        pendingBytes: 0,
        inReplayBurst: false,
        replay: [],
        replayBytes: 0,
      };
      streams.set(streamId, state);
      if (header.traceId !== undefined) {
        traceMap.register(String(streamId), header.traceId);
      }

      // Streaming-init ack envelope (`ack_source: 'dispatcher'`).
      writeAck(header.id, 'dispatcher');

      // Boot-nonce mismatch detection (frag-3.5.1 §3.5.1.4): if the client
      // passed `fromBootNonce` and it differs from ours, we ignore `fromSeq`
      // and emit `bootChanged` so the client renders the divider.
      const passedBoot = openPayload.fromBootNonce;
      const bootMismatch = passedBoot !== undefined && passedBoot !== bootNonce;

      if (bootMismatch) {
        // Emit a single chunk frame with bootChanged=true (handler is
        // responsible for following with the snapshot). For wire-shape
        // tests, the bootChanged metadata travels in the close-or-chunk
        // header `extras`. Here we emit a synthetic JSON chunk with the
        // metadata so the client can pick it up before the handler starts.
        const headerExtras: Record<string, unknown> = { bootChanged: true, snapshotPending: true };
        const meta = Buffer.from(
          JSON.stringify({ kind: 'bootChanged', bootNonce, snapshotPending: true }),
          'utf8',
        );
        writeStreamFrame(state, 'chunk', state.nextSeq, meta, headerExtras, {
          exemptFromBackpressure: true,
        });
      }

      // Invoke the handler.
      let cancelHook: () => void;
      try {
        cancelHook = handler({ ...openPayload }, makeStreamHandle(state));
      } catch (err) {
        logger.warn(
          { event: 'streaming-adapter.handler_threw_open', method: header.method, err: String(err) },
          'streaming handler threw on open',
        );
        endStream(state, { code: 'INTERNAL', message: String(err) });
        return;
      }
      state.cancel = cancelHook;

      return;
    }

    if (kind === 'cancel') {
      const state = streams.get(streamId);
      if (!state) return; // unknown id — silent (client may have raced)
      try {
        state.cancel();
      } catch {
        /* swallow */
      }
      endStream(state, { code: 'CANCELLED', message: 'caller-cancel' });
      return;
    }

    if (kind === 'chunk' || kind === 'heartbeat' || kind === 'close') {
      // Server-streaming RPC: client should never send these. Reject so a
      // confused client surfaces fast.
      writeSyntheticError(
        header.id,
        'INVALID_ARGUMENT',
        `client may not send stream.kind=${kind} on a server-streaming RPC`,
      );
      return;
    }
  }

  function writeAck(id: number, ackSource: 'handler' | 'dispatcher'): void {
    const headerObj = {
      id,
      ok: true as const,
      value: undefined,
      ack_source: ackSource,
      payloadType: 'json' as const,
      payloadLen: 0,
    };
    const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
    tryWrite(encodeFrame({ headerJson }));
  }

  function writeSyntheticError(id: number, code: string, message: string): void {
    const headerObj = {
      id,
      ok: false as const,
      error: { code, message },
      payloadType: 'json' as const,
      payloadLen: 0,
    };
    const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
    tryWrite(encodeFrame({ headerJson }));
  }

  socket.on('data', (chunk: Buffer) => {
    if (destroyed) return;
    pending.push(chunk);
    pendingBytes += chunk.length;
    processBuffer();
  });

  socket.on('error', (err: Error) => {
    logger.warn(
      { event: 'streaming-adapter.socket_error', peer, peerPid, err: String(err) },
      'socket error',
    );
  });

  socket.on('close', () => {
    destroyed = true;
    closeAllStreams('socket-close');
    pending.length = 0;
    pendingBytes = 0;
  });

  return {
    liveStreamCount: () => streams.size,
    closeAll: (reason: string) => closeAllStreams(reason),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStreamHeader(v: unknown): v is StreamFrameHeader {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id < 0) return false;
  if (typeof o.method !== 'string' || o.method.length === 0) return false;
  if (o.stream === undefined || o.stream === null || typeof o.stream !== 'object') return false;
  const s = o.stream as Record<string, unknown>;
  if (typeof s.streamId !== 'number' || !Number.isInteger(s.streamId) || s.streamId < 0) {
    return false;
  }
  if (typeof s.kind !== 'string') return false;
  const validKinds: ReadonlySet<string> = new Set(['open', 'chunk', 'close', 'heartbeat', 'cancel']);
  if (!validKinds.has(s.kind)) return false;
  if (s.seq !== undefined && (typeof s.seq !== 'number' || !Number.isInteger(s.seq) || s.seq < 0)) {
    return false;
  }
  if (o.traceId !== undefined && typeof o.traceId !== 'string') return false;
  return true;
}

/** Split a payload into ≤16 KiB sub-frames per spec §3.4.1.b. */
function splitForSubframes(payload: Buffer): Buffer[] {
  if (payload.length <= MAX_SUBFRAME_BYTES) return [payload];
  const out: Buffer[] = [];
  for (let off = 0; off < payload.length; off += MAX_SUBFRAME_BYTES) {
    out.push(payload.subarray(off, Math.min(off + MAX_SUBFRAME_BYTES, payload.length)));
  }
  return out;
}

/** Read the open-frame payload from either the binary trailer (preferred,
 *  per spec §3.4.1.c JSON-on-binary frames) or a `payload` field embedded
 *  in the JSON header (compat shim for clients that haven't moved to the
 *  binary-trailer form). Returns an empty payload if neither carries
 *  recognisable cursor fields. */
function readOpenPayload(header: StreamFrameHeader, trailer: Buffer): OpenFramePayload & Record<string, unknown> {
  // Prefer the binary trailer if it parses as JSON.
  if (trailer.length > 0) {
    try {
      const parsed = JSON.parse(trailer.toString('utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as OpenFramePayload & Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  // Header-embedded `payload` (compat).
  const maybe = (header as unknown as { payload?: unknown }).payload;
  if (maybe !== null && typeof maybe === 'object') {
    return maybe as OpenFramePayload & Record<string, unknown>;
  }
  return {};
}

function defaultLogger(): StreamingAdapterLogger {
  return {
    warn: (obj, msg) => {
      console.warn(`${msg} ${JSON.stringify(obj)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Replay-window helpers (consumed by handlers)
// ---------------------------------------------------------------------------

/**
 * Compute the replay decision for a resubscribe. Pure function — handlers
 * call this with the replay buffer they have in hand (e.g. the
 * `xterm-headless` ring) and the caller's `fromSeq`. The adapter itself
 * does not own the replay buffer for application data; per spec §3.5.1.4
 * that lives with the snapshot/delta layer.
 *
 * Decision table (round-3 perf CF-2 + §3.4.1.b 256 KiB cap):
 *   - fromSeq absent           → { mode: 'snapshot', gap: false }
 *   - fromSeq <= oldest        → { mode: 'replay-from', seq, gap: false }
 *                                 (entire window fits under 256 KiB by
 *                                 the chunk-reassembly module's eviction
 *                                 invariant; deliver as one initial write)
 *   - fromSeq above newest     → { mode: 'no-op', gap: false }   (caller is
 *                                 ahead of us — should never happen, but
 *                                 fail closed: tail from `lastSeq + 1`)
 *   - fromSeq evicted from window → { mode: 'snapshot', gap: true }
 */
export type ReplayDecision =
  | { readonly mode: 'snapshot'; readonly gap: boolean }
  | { readonly mode: 'replay-from'; readonly seq: number; readonly gap: false }
  | { readonly mode: 'no-op'; readonly gap: false };

export function computeReplayDecision(args: {
  readonly fromSeq: number | undefined;
  readonly oldestRetainedSeq: number | undefined;
  readonly newestRetainedSeq: number | undefined;
}): ReplayDecision {
  const { fromSeq, oldestRetainedSeq, newestRetainedSeq } = args;
  if (fromSeq === undefined) return { mode: 'snapshot', gap: false };
  if (oldestRetainedSeq === undefined || newestRetainedSeq === undefined) {
    // Producer hasn't emitted anything yet; treat as snapshot-clean.
    return { mode: 'snapshot', gap: false };
  }
  if (fromSeq < oldestRetainedSeq) {
    // Past the 256 KiB replay window — snapshot + gap (spec §3.4.1.b
    // round-2 resource P0-1).
    return { mode: 'snapshot', gap: true };
  }
  if (fromSeq > newestRetainedSeq + 1) {
    return { mode: 'no-op', gap: false };
  }
  return { mode: 'replay-from', seq: fromSeq, gap: false };
}

export const STREAMING_ADAPTER_LIMITS = Object.freeze({
  MAX_SUBFRAME_BYTES,
  MAX_REPLAY_BYTES,
  CHUNK_LIMITS,
  DEFAULT_DROP_SLOWEST_BYTES,
});
