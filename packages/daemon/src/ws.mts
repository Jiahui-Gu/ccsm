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
    // T#668: ws no longer spawns PTYs. The runtime must already exist (created
    // via POST /api/sessions or POST /api/sessions/:sid/resume). If it doesn't
    // we close with 1008 ("policy violation") and a machine-readable reason
    // the frontend can branch on to issue a /resume call.
    const rt: RuntimeSession | undefined = registry.get(sid);
    if (!rt) {
      ws.close(1008, 'session_not_spawned');
      return;
    }

    if (rt.exited) {
      try {
        ws.send(encodeFrame({ type: FrameType.EXIT, seq: rt.outputSeq, payload: encodeExit(rt.exitCode) }));
      } catch {
        // ignore
      }
      ws.close(1000, 'exited');
      return;
    }

    // T8 #661: lastSeq replay BEFORE adding ws to subscribers, so we don't
    // interleave replayed bytes with a freshly-arriving live OUTPUT.
    if (lastSeq < rt.outputSeq) {
      const replay = rt.ring.range(lastSeq + 1, rt.outputSeq);
      if (replay === null) {
        try {
          ws.send(
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
            ws.send(
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

    // Add to subscribers (registry's fan-out loop sees us via the shared Map).
    rt.subscribers.set(ws as unknown as SubscriberSocket, {
      paused: false,
      pausedQueue: [],
      pausedBytes: 0,
    });

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
      let frame;
      try {
        frame = decodeFrame(buf);
      } catch (err) {
        console.warn('[ccsm/ws] bad frame from client:', (err as Error).message);
        return;
      }
      handleClientFrame(rt, ws, frame.type, frame.payload);
    });

    const cleanup = (): void => {
      rt.subscribers.delete(ws as unknown as SubscriberSocket);
      // T#668 spec: ws on close should kill its OWN PTY if subscribers empty
      // (matches T4 behaviour — keeps daemon footprint tied to the active tab).
      if (rt.subscribers.size === 0 && !rt.exited) {
        registry.kill(sid);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', (err) => {
      console.warn(`[ccsm/ws] socket error sid=${sid}:`, err.message);
    });
  }

  function handleClientFrame(
    rt: RuntimeSession,
    ws: WSWebSocket,
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
        const state = rt.subscribers.get(ws as unknown as SubscriberSocket);
        if (state) state.paused = true;
        break;
      }
      case FrameType.RESUME: {
        const state = rt.subscribers.get(ws as unknown as SubscriberSocket);
        if (!state) break;
        state.paused = false;
        if (state.pausedQueue.length > 0) {
          const queued = state.pausedQueue;
          state.pausedQueue = [];
          state.pausedBytes = 0;
          for (const frame of queued) {
            if (ws.readyState !== ws.OPEN) break;
            try {
              ws.send(frame);
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

  async function shutdown(): Promise<void> {
    server.removeListener('upgrade', onUpgrade);
    registry.shutdownAll();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return { wss, shutdown };
}
