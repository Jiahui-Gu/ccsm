// electron/daemonClient/rpcClient.ts
//
// Electron-side socket-RPC client for the v0.3 daemon-split (Task #27 / B7b).
// Pairs with the daemon-side envelope adapter (`daemon/src/envelope/adapter.ts`,
// PR #773 / Task #28). Together they complete the v0.3 IPC layer that
// replaces the v0.2 in-process / hand-rolled transport.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.a frame-version nibble + 16 MiB cap (encode/decode in
//     ./envelope.ts);
//     §3.4.1.c JSON header schema (`{ id, method, payloadType, payloadLen,
//     traceId? }`); reply shape `{ id, ok: true, value, ack_source }` /
//     `{ id, ok: false, error: { code, message } }`.
//   - frag-3.4.1 §3.4.1.h two-socket topology — Electron-main connects to
//     BOTH control-socket (supervisor-plane RPCs in `SUPERVISOR_RPCS`) AND
//     data-socket (everything else). This file is transport-agnostic; the
//     caller (controlClient.ts / dataClient.ts) supplies the path.
//
// What this module deliberately does NOT do (out of scope for B7b):
//   - HMAC handshake (`daemon.hello`), version negotiation, peer-cred check.
//     The daemon side currently accepts unauthenticated frames (PR #773 ships
//     the framing layer only; interceptors arrive in their own slices). When
//     the hello-interceptor lands daemon-side, this client gains a one-time
//     handshake at connect time before resolving the first user RPC.
//   - Streaming RPCs (chunked PTY subscribe). Unary only — sufficient for
//     today's call site (`daemon.shutdownForUpgrade`). The frame format
//     supports streams natively; adding them is a follow-up.
//   - Renderer <-> main IPC. Renderer keeps using contextBridge / ipcMain
//     unchanged — that's NOT part of the daemon-split migration.
//
// Single Responsibility (per dev contract §2):
//   - PRODUCER: socket `data` events accumulate into a per-connection buffer.
//   - DECIDER: `decodeFrame` (pure) -> JSON.parse -> route reply by `id`.
//   - SINK: `socket.write(encodedFrame)` -- request emit + connect/close.
//
// Reconnect policy:
//   - The spec (§3.7.4) owns the canonical reconnect schedule but only the
//     daemon-supervisor side is normative; this client implements a simple
//     bounded exponential backoff (250 ms, 500 ms, 1 s, 2 s, capped 5 s)
//     suitable for the v0.3 dogfood-only scope. Pending in-flight calls at
//     disconnect time are rejected with `RPC_DISCONNECTED` so the caller
//     can decide whether to retry. We do NOT auto-resend across reconnects
//     because re-issuing `daemon.shutdownForUpgrade` (the v0.3 caller) twice
//     would be unsafe; future stream subscribers gain auto-resubscribe via
//     the existing streamHandleTable cleanup hook.

import { Buffer } from 'node:buffer';
import { connect, type Socket } from 'node:net';
import { decodeFrame, encodeFrame, EnvelopeError } from './envelope';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RpcClientOptions {
  /** Absolute socket path or Windows named-pipe path. */
  readonly socketPath: string;
  /** Per-call default timeout in milliseconds. Defaults to 5_000 (matches
   *  the spec §3.4.1.c default `x-ccsm-deadline-ms`). Caller may override
   *  per-call via `RpcCallOptions.timeoutMs`. */
  readonly defaultTimeoutMs?: number;
  /** Test seam: substitute the `net.connect` factory. Defaults to
   *  `node:net.connect`. */
  readonly connectFn?: (path: string) => Socket;
  /** Optional log sink for warn lines (connect failure, decode error,
   *  unexpected reply id). Defaults to `console.warn`. */
  readonly log?: (line: string, extras?: Record<string, unknown>) => void;
  /** Reconnect backoff schedule in ms. First element used on the first
   *  reconnect; the last is held for subsequent attempts. Defaults to
   *  `[250, 500, 1000, 2000, 5000]`. Pass `[]` to disable reconnect entirely
   *  (one-shot connection — the client closes after the first disconnect
   *  and rejects all subsequent calls). */
  readonly reconnectBackoffMs?: readonly number[];
}

export interface RpcCallOptions {
  /** Override the per-client default. */
  readonly timeoutMs?: number;
  /** Optional Crockford ULID for trace correlation. The daemon side
   *  forwards this to handlers via `DispatchContext.traceId`. */
  readonly traceId?: string;
}

/** Successful reply mirrors the daemon's `DispatchOk` shape. */
export interface RpcOkReply<T = unknown> {
  readonly ok: true;
  readonly value: T;
  readonly ack_source: 'handler' | 'dispatcher';
}

/** Error reply mirrors the daemon's `DispatchErr` shape. */
export interface RpcErrReply {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly method?: string;
  };
}

export type RpcReply<T = unknown> = RpcOkReply<T> | RpcErrReply;

/** Typed error thrown by `call()` on transport failure (timeout, disconnect,
 *  decode error). Application-level errors arrive as `RpcErrReply` and DO NOT
 *  throw — caller inspects `reply.ok`. */
export class RpcTransportError extends Error {
  public readonly code: 'RPC_TIMEOUT' | 'RPC_DISCONNECTED' | 'RPC_NOT_CONNECTED' | 'RPC_DECODE';
  constructor(
    code: 'RPC_TIMEOUT' | 'RPC_DISCONNECTED' | 'RPC_NOT_CONNECTED' | 'RPC_DECODE',
    message: string,
  ) {
    super(message);
    this.name = 'RpcTransportError';
    this.code = code;
  }
}

export interface RpcClient {
  /** Connect (idempotent). Resolves once the socket is `connect`-ready.
   *  Subsequent calls await the in-flight connection. */
  connect(): Promise<void>;
  /** Send a unary RPC; resolve with the reply envelope (ok or err). Reject
   *  with `RpcTransportError` on transport failure. */
  call<T = unknown>(method: string, payload?: unknown, opts?: RpcCallOptions): Promise<RpcReply<T>>;
  /** Close the socket and stop reconnecting. Idempotent. Pending calls
   *  reject with `RPC_DISCONNECTED`. */
  close(): void;
  /** Snapshot of liveness for tests / debug overlays. */
  readonly isConnected: boolean;
  readonly pendingCount: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly id: number;
  readonly method: string;
  readonly resolve: (reply: RpcReply) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_BACKOFF: readonly number[] = [250, 500, 1000, 2000, 5000] as const;

export function createRpcClient(opts: RpcClientOptions): RpcClient {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 5_000;
  const connectFn = opts.connectFn ?? ((p: string) => connect(p));
  const log = opts.log ?? ((line: string, extras?: Record<string, unknown>) => {
    if (extras) console.warn(`[rpc-client] ${line}`, extras);
    else console.warn(`[rpc-client] ${line}`);
  });
  const backoff = opts.reconnectBackoffMs ?? DEFAULT_BACKOFF;
  const reconnectEnabled = backoff.length > 0;

  let socket: Socket | null = null;
  let connectPromise: Promise<void> | null = null;
  let connected = false;
  let closed = false;
  let nextId = 1;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-connection inbound buffer. A single Buffer accumulator keeps decode
  // O(N) on the read side; for v0.3 dogfood load (occasional unary RPC) the
  // simpler array+concat approach the daemon adapter uses would also work
  // but a single buffer keeps the loop body shorter.
  let inbound: Buffer = Buffer.alloc(0);

  const pending = new Map<number, PendingCall>();

  function rejectAllPending(err: Error): void {
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function scheduleReconnect(): void {
    if (closed || !reconnectEnabled) return;
    const delay = backoff[Math.min(reconnectAttempt, backoff.length - 1)] ?? 5_000;
    reconnectAttempt += 1;
    log(`scheduling reconnect in ${delay}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Discard the resolved promise; subsequent .connect() calls (or the
      // next .call()) await a fresh connectPromise.
      void doConnect().catch(() => {
        // Already logged inside doConnect; backoff handles re-scheduling.
      });
    }, delay);
    (reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  function onSocketData(chunk: Buffer): void {
    inbound = inbound.length === 0 ? chunk : Buffer.concat([inbound, chunk]);
    // Loop until we're short of a full frame.
    for (;;) {
      let decoded;
      try {
        decoded = decodeFrame(inbound);
      } catch (err) {
        if (err instanceof EnvelopeError && err.code === 'truncated_frame') {
          // Wait for more bytes.
          return;
        }
        // Unrecoverable framing error — destroy + reject all.
        log(`decode failed: ${(err as Error).message}`, {
          code: err instanceof EnvelopeError ? err.code : 'unknown',
        });
        if (socket) {
          try { socket.destroy(); } catch { /* ignore */ }
        }
        return;
      }

      const consumed =
        4 /* prefix */ + 2 /* headerLen */ + decoded.headerJson.length + decoded.payload.length;
      inbound = inbound.subarray(consumed);

      let header: unknown;
      try {
        header = JSON.parse(decoded.headerJson.toString('utf8'));
      } catch {
        log('reply header is not valid JSON; dropping');
        continue;
      }
      if (header === null || typeof header !== 'object') {
        log('reply header is not an object; dropping');
        continue;
      }
      const h = header as Record<string, unknown>;
      const id = h.id;
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        log('reply header missing numeric id; dropping');
        continue;
      }

      // id === 0 is reserved for daemon-side synthetic error replies that
      // could not bind to any in-flight call (e.g. an oversize frame the
      // adapter rejects before parsing). Surface as a warn line; we cannot
      // route it to a caller.
      if (id === 0) {
        log(`synthetic daemon error reply (id=0)`, { header: h });
        continue;
      }

      const call = pending.get(id);
      if (!call) {
        log(`reply for unknown id=${id}; dropping`);
        continue;
      }
      pending.delete(id);
      if (call.timer) clearTimeout(call.timer);

      // Normalise the reply into RpcReply discriminated union.
      if (h.ok === true) {
        const value = h.value;
        const ackSource =
          h.ack_source === 'dispatcher' || h.ack_source === 'handler'
            ? (h.ack_source as 'dispatcher' | 'handler')
            : 'handler';
        call.resolve({ ok: true, value, ack_source: ackSource });
      } else if (h.ok === false) {
        const errObj = (h.error ?? {}) as Record<string, unknown>;
        const code = typeof errObj.code === 'string' ? errObj.code : 'INTERNAL';
        const message = typeof errObj.message === 'string' ? errObj.message : '';
        const reply: RpcErrReply = {
          ok: false,
          error: typeof errObj.method === 'string'
            ? { code, message, method: errObj.method }
            : { code, message },
        };
        call.resolve(reply);
      } else {
        // Spec violation — surface as transport-level decode error.
        call.reject(new RpcTransportError('RPC_DECODE', `reply id=${id} missing ok flag`));
      }
    }
  }

  function doConnect(): Promise<void> {
    if (closed) {
      return Promise.reject(new RpcTransportError('RPC_NOT_CONNECTED', 'client is closed'));
    }
    if (connected) return Promise.resolve();
    if (connectPromise) return connectPromise;

    connectPromise = new Promise<void>((resolve, reject) => {
      const sock = connectFn(opts.socketPath);
      socket = sock;
      inbound = Buffer.alloc(0);

      const onConnect = (): void => {
        connected = true;
        reconnectAttempt = 0;
        connectPromise = null;
        sock.removeListener('error', onErrorBeforeConnect);
        resolve();
      };
      const onErrorBeforeConnect = (err: Error): void => {
        connected = false;
        connectPromise = null;
        sock.removeListener('connect', onConnect);
        try { sock.destroy(); } catch { /* ignore */ }
        socket = null;
        log(`connect failed: ${err.message}`);
        scheduleReconnect();
        reject(err);
      };

      sock.once('connect', onConnect);
      sock.once('error', onErrorBeforeConnect);

      sock.on('data', (chunk: Buffer) => onSocketData(chunk));

      sock.on('error', (err: Error) => {
        // Post-connect errors get logged; the matching `close` handler does
        // the cleanup (Node always emits `close` after `error` on Sockets).
        if (connected) log(`socket error: ${err.message}`);
      });

      sock.on('close', () => {
        const wasConnected = connected;
        connected = false;
        socket = null;
        inbound = Buffer.alloc(0);
        rejectAllPending(
          new RpcTransportError('RPC_DISCONNECTED', 'socket closed before reply'),
        );
        if (wasConnected) scheduleReconnect();
      });
    });
    return connectPromise;
  }

  async function call<T = unknown>(
    method: string,
    payload?: unknown,
    callOpts?: RpcCallOptions,
  ): Promise<RpcReply<T>> {
    if (closed) {
      throw new RpcTransportError('RPC_NOT_CONNECTED', 'client is closed');
    }
    await doConnect();
    if (!socket || !connected) {
      throw new RpcTransportError('RPC_NOT_CONNECTED', 'socket is not connected');
    }

    const id = nextId++;
    const timeoutMs = callOpts?.timeoutMs ?? defaultTimeoutMs;

    const headerObj: Record<string, unknown> = {
      id,
      method,
      payloadType: 'json',
      payloadLen: 0,
    };
    if (callOpts?.traceId !== undefined) headerObj.traceId = callOpts.traceId;
    if (payload !== undefined) headerObj.payload = payload;

    const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
    const frame = encodeFrame({ headerJson });

    return new Promise<RpcReply<T>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              reject(
                new RpcTransportError(
                  'RPC_TIMEOUT',
                  `RPC ${method} (id=${id}) timed out after ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs)
          : null;
      if (timer) (timer as unknown as { unref?: () => void }).unref?.();

      pending.set(id, {
        id,
        method,
        resolve: (r) => resolve(r as RpcReply<T>),
        reject,
        timer,
      });

      try {
        socket!.write(frame);
      } catch (err) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(
          new RpcTransportError(
            'RPC_DISCONNECTED',
            `socket.write failed: ${(err as Error).message}`,
          ),
        );
      }
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      try { socket.destroy(); } catch { /* ignore */ }
      socket = null;
    }
    rejectAllPending(
      new RpcTransportError('RPC_DISCONNECTED', 'client closed by caller'),
    );
    connected = false;
    connectPromise = null;
  }

  return {
    connect: doConnect,
    call,
    close,
    get isConnected() { return connected; },
    get pendingCount() { return pending.size; },
  };
}
