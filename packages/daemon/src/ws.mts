// WebSocket server: subscriber transport for live PTY sessions.
//
// Task #668: PTY spawn used to live here (lazy on first ws upgrade). It now
// lives in HTTP-layer routes (POST /api/sessions, POST /:sid/resume) and is
// owned by RuntimeRegistry (runtime.mts). This module is purely a transport:
//   - validate token / origin / sid at upgrade
//   - on connect: registry.get(sid). Missing -> close(1008, 'session_not_spawned')
//   - subscribe to runtime.subscribers, replay ring per lastSeq, forward client
//     frames (INPUT/RESIZE/PAUSE/RESUME) to the PTY
//
// OUTPUT/EXIT broadcast and the per-subscriber pause queue cap live in
// runtime.mts (so http.mts and ws.mts share the same fan-out path).

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';

import {
  encodeExit,
  encodeFrame,
  decodeFrame,
  decodeResize,
  FrameType,
} from '@ccsm/shared';
import type { WebSocket as WSWebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { classifyOrigin } from './auth.mjs';
import type {
  RuntimeRegistry,
  RuntimeSession,
  SessionLike,
  SubscriberSocket,
} from './runtime.mjs';

// Maximum payload bytes per OUTPUT replay frame.
const REPLAY_CHUNK_BYTES = 64 * 1024;

export interface AttachWsOptions {
  /** Pre-shared token (same one passed to createDaemonHttp). */
  token: string;
  /** Stub session map owned by createDaemonHttp. */
  sessions: Map<string, SessionLike>;
  /** Runtime registry shared with the HTTP layer. */
  registry: RuntimeRegistry;
}

export interface AttachedWs {
  wss: WebSocketServer;
  /** For tests / hot reload: tear down all PTYs + close all subscribers. */
  shutdown(): Promise<void>;
}

// Re-export for backwards-compat with tests/imports.
export type { PtyFactory, PtyLike, SessionLike } from './runtime.mjs';

// ---- attachFrameRouter -------------------------------------------------
//
// Task #793 (S3-G): the per-session frame routing that used to live inline in
// attachWebSocket's onConnection is now an exported helper so the cloud-tunnel
// path (TunnelClient.onBrowserAttach in tunnel.mts) can reuse the EXACT same
// fan-out logic — replay → subscribe → forward client frames into the PTY —
// without the loopback ws server. The only differences vs the loopback path:
//
//   - the wire is a `send(Uint8Array)` callback supplied by the caller
//     (tunnel.mts wraps its own `tunnel.send`; ws.mts wraps `ws.send`);
//   - cleanup is not driven by ws lifecycle events — the caller invokes
//     `close()` when its own connection drops.
//
// Both paths land on the same RuntimeRegistry (so a tunnel-attached browser
// and a same-origin loopback browser see identical subscriber-list semantics:
// same ring replay, same OUTPUT fan-out, same kill-on-last-subscriber).

/** Bytes-out channel the router uses to push frames to the client. */
export type FrameSendFn = (data: Uint8Array) => void;

export interface AttachFrameRouterOptions {
  sid: string;
  lastSeq: number;
  registry: RuntimeRegistry;
  /** Send a single (already-encoded) frame back to the client. */
  send: FrameSendFn;
  /**
   * Close the underlying transport with a code + reason. Invoked by the
   * registry on PTY exit (`1000 'exited'`) or pause-queue overflow
   * (`1009 'pause_queue_overflow'`). For the loopback ws path this maps to
   * `ws.close(code, reason)`; for the cloud-tunnel path the daemon main
   * does NOT close the tunnel ws (it stays up for the next browser pairing)
   * — the tunnel adapter passes a no-op so subscriber-level closes don't
   * tear the entire tunnel down.
   */
  closeTransport?: (code?: number, reason?: string) => void;
}

export interface FrameRouter {
  /** Feed an inbound binary frame from the client (INPUT/RESIZE/PAUSE/RESUME). */
  onFrame: (data: Uint8Array | Buffer) => void;
  /**
   * Drop this attachment from the runtime's subscriber set. If we were the
   * last subscriber, kicks off PTY kill (matches the loopback ws behaviour).
   * Idempotent.
   */
  close: () => void;
  /**
   * True iff the runtime accepted the attachment (i.e. sid was found and the
   * session was not already exited). When false the caller should close the
   * underlying transport with a reasonable code (1008 / 1000 'exited').
   */
  attached: boolean;
}

/**
 * Wire a single subscriber (loopback ws OR cloud-tunnel browser) into the
 * runtime registry's per-session fan-out.
 *
 * Returns a `FrameRouter` whose `onFrame` should be called for every inbound
 * binary frame on the underlying transport, and whose `close` should be
 * called when that transport drops. `attached` reports whether the
 * registry accepted the subscription so the caller can short-circuit on
 * not-found / already-exited.
 */
export function attachFrameRouter(opts: AttachFrameRouterOptions): FrameRouter {
  const { sid, lastSeq, registry, send } = opts;
  const closeTransport = opts.closeTransport;

  const rt = registry.get(sid);
  if (!rt) {
    return {
      onFrame: () => {
        /* noop — caller should have closed already */
      },
      close: () => {
        /* noop */
      },
      attached: false,
    };
  }

  if (rt.exited) {
    try {
      send(
        encodeFrame({ type: FrameType.EXIT, seq: rt.outputSeq, payload: encodeExit(rt.exitCode) }),
      );
    } catch {
      // ignore — caller is about to close the transport
    }
    return {
      onFrame: () => {
        /* noop */
      },
      close: () => {
        /* noop */
      },
      attached: false,
    };
  }

  // Replay BEFORE adding to subscribers so we don't interleave replayed
  // bytes with a fresh live OUTPUT (Task #661 invariant).
  if (lastSeq < rt.outputSeq) {
    const replay = rt.ring.range(lastSeq + 1, rt.outputSeq);
    if (replay === null) {
      try {
        send(
          encodeFrame({
            type: FrameType.RESET,
            seq: rt.outputSeq,
            payload: new Uint8Array(0),
          }),
        );
      } catch (err) {
        console.warn('[ccsm/ws] RESET send failed:', (err as Error).message);
      }
    } else if (replay.byteLength > 0) {
      const total = replay.byteLength;
      for (let off = 0; off < total; off += REPLAY_CHUNK_BYTES) {
        const end = Math.min(off + REPLAY_CHUNK_BYTES, total);
        const chunk = replay.subarray(off, end);
        try {
          send(
            encodeFrame({
              type: FrameType.OUTPUT,
              seq: rt.outputSeq,
              payload: chunk,
            }),
          );
        } catch (err) {
          console.warn('[ccsm/ws] replay send failed:', (err as Error).message);
          break;
        }
      }
    }
  }

  // Synthesize a SubscriberSocket-shaped object so the registry's fan-out
  // loop can call `.send()` / `.close()` / read `.readyState` against it
  // exactly the way it does for a real `ws.WebSocket`. We keep readyState
  // wired to OPEN until close() flips it; the registry checks
  // `sock.readyState === sock.OPEN` before each frame.
  let readyState = 1; // OPEN
  const sock: SubscriberSocket = {
    get readyState() {
      return readyState;
    },
    OPEN: 1,
    send: (data: Uint8Array) => {
      try {
        console.error('[r38-sub-send] sid=' + sid + ' bytes=' + data.byteLength);
        send(data);
      } catch (err) {
        console.warn('[ccsm/ws] router send failed:', (err as Error).message);
      }
    },
    close: (code?: number, reason?: string) => {
      readyState = 3; // CLOSED
      if (closeTransport !== undefined) {
        try {
          closeTransport(code, reason);
        } catch {
          // ignore — best-effort
        }
      }
    },
  };

  rt.subscribers.set(sock, {
    paused: false,
    pausedQueue: [],
    pausedBytes: 0,
  });
  console.error('[r38-subscriber-added] sid=' + sid + ' subs_now=' + rt.subscribers.size + ' lastSeq=' + lastSeq + ' rt_outputSeq=' + rt.outputSeq);

  // Capture the narrowed runtime ref so the closures below don't re-fetch
  // (also satisfies TS, which loses the narrow across closure boundaries).
  const runtimeRef: RuntimeSession = rt;

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    readyState = 3;
    runtimeRef.subscribers.delete(sock);
    if (runtimeRef.subscribers.size === 0 && !runtimeRef.exited) {
      void registry.kill(sid);
    }
  }

  function onFrame(raw: Uint8Array | Buffer): void {
    if (closed) return;
    let buf: Uint8Array;
    if (raw instanceof Buffer) {
      buf = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } else {
      buf = raw;
    }
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch (err) {
      console.warn('[ccsm/ws] bad frame from client:', (err as Error).message);
      return;
    }
    handleClientFrame(runtimeRef, sock, frame.type, frame.payload);
  }

  return { onFrame, close, attached: true };
}

/**
 * Per-frame dispatch shared by both the loopback ws server and the cloud-
 * tunnel attachment (Task #793). Pulled out so we don't duplicate the
 * INPUT/RESIZE/PAUSE/RESUME handling — both transports drive the same PTY
 * via the same code path.
 */
function handleClientFrame(
  rt: RuntimeSession,
  sock: SubscriberSocket,
  type: FrameType,
  payload: Uint8Array,
): void {
  switch (type) {
    case FrameType.INPUT: {
      const s = Buffer.from(payload).toString('utf8');
      try {
        rt.pty.write(s);
      } catch (err) {
        console.warn('[ccsm/ws] pty.write error:', (err as Error).message);
      }
      break;
    }
    case FrameType.RESIZE: {
      let dims;
      try {
        dims = decodeResize(payload);
      } catch (err) {
        console.warn('[ccsm/ws] bad resize payload:', (err as Error).message);
        return;
      }
      try {
        rt.pty.resize(dims.cols, dims.rows);
      } catch (err) {
        console.warn('[ccsm/ws] pty.resize error:', (err as Error).message);
      }
      break;
    }
    case FrameType.PAUSE: {
      const state = rt.subscribers.get(sock);
      if (state) state.paused = true;
      break;
    }
    case FrameType.RESUME: {
      const state = rt.subscribers.get(sock);
      if (!state) break;
      state.paused = false;
      if (state.pausedQueue.length > 0) {
        const queued = state.pausedQueue;
        state.pausedQueue = [];
        state.pausedBytes = 0;
        for (const frame of queued) {
          if (sock.readyState !== sock.OPEN) break;
          try {
            sock.send(frame);
          } catch (err) {
            console.warn('[ccsm/ws] resume flush send failed:', (err as Error).message);
            break;
          }
        }
      }
      break;
    }
    default:
      console.warn(`[ccsm/ws] ignoring c->s frame type=0x${type.toString(16)}`);
  }
}

// ---- Auth helpers (mirrors auth.mts logic for ws upgrade) ---------------
// Origin policy is shared with HTTP via `classifyOrigin` (auth.mts):
//   - 'absent'   -> same-origin per #672, allow.
//   - 'allowed'  -> loopback http(s) or `tauri://localhost` (T2 #675).
//   - 'rejected' -> close upgrade with 403.

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      '\r\n',
  );
  socket.destroy();
}

// ---- attachWebSocket ----------------------------------------------------

export function attachWebSocket(server: HttpServer, opts: AttachWsOptions): AttachedWs {
  const { token, sessions, registry } = opts;

  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      return;
    }

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    // 'absent' = same-origin (#672), allow; 'allowed' = loopback or tauri://localhost.
    if (classifyOrigin(origin) === 'rejected') {
      console.warn(`[ccsm/ws] reject origin=${JSON.stringify(origin ?? null)}`);
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const presented = url.searchParams.get('token') ?? '';
    if (presented.length === 0 || !constantTimeEquals(presented, token)) {
      console.warn('[ccsm/ws] reject token (mismatch or missing)');
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const sid = url.searchParams.get('sid') ?? '';
    if (sid.length === 0 || !sessions.has(sid)) {
      console.warn(`[ccsm/ws] reject sid=${JSON.stringify(sid)} (not found)`);
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const lastSeqRaw = url.searchParams.get('lastSeq');
    let lastSeq = 0;
    if (lastSeqRaw !== null) {
      const n = Number(lastSeqRaw);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
        lastSeq = n;
      } else {
        console.warn(`[ccsm/ws] ignoring bad lastSeq=${JSON.stringify(lastSeqRaw)}`);
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, sid, lastSeq);
    });
  };

  server.on('upgrade', onUpgrade);

  function onConnection(ws: WSWebSocket, sid: string, lastSeq: number): void {
    // Delegate the per-session frame routing to the shared helper so the
    // loopback ws path and the cloud-tunnel path (Task #793, S3-G) share the
    // same replay → subscribe → forward semantics. ws.send accepts the
    // encoded frame directly; on attach failure we close with a machine-
    // readable reason the frontend branches on.
    const router = attachFrameRouter({
      sid,
      lastSeq,
      registry,
      send: (data) => {
        ws.send(data);
      },
      closeTransport: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          // already closing — ignore
        }
      },
    });
    if (!router.attached) {
      // Either sid not registered or runtime already exited. The helper has
      // already emitted EXIT for the exited case; for not-found we close
      // 1008 with the machine-readable reason the frontend uses to issue
      // /resume.
      const rt = registry.get(sid);
      if (!rt) {
        ws.close(1008, 'session_not_spawned');
      } else {
        ws.close(1000, 'exited');
      }
      return;
    }

    ws.on('message', (raw, isBinary) => {
      if (!isBinary) return;
      let buf: Uint8Array;
      if (raw instanceof Buffer) {
        buf = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else if (Array.isArray(raw)) {
        buf = new Uint8Array(Buffer.concat(raw));
      } else {
        buf = new Uint8Array(raw as ArrayBuffer);
      }
      router.onFrame(buf);
    });

    ws.on('close', () => {
      router.close();
    });
    ws.on('error', (err) => {
      console.warn(`[ccsm/ws] socket error sid=${sid}:`, err.message);
    });
  }

  async function shutdown(): Promise<void> {
    server.removeListener('upgrade', onUpgrade);
    registry.shutdownAll();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return { wss, shutdown };
}
