// WebSocket server: binary frame protocol + node-pty session bridge
// (DESIGN.md §5, §6, F4). Mounted on the same http.Server as the REST API,
// reusing the same token + origin auth as auth.mts.
//
// Scope (T4):
//   - 1 ws per (sid, browser-tab); single PTY per session.
//   - INPUT  (0x02) -> pty.write
//   - RESIZE (0x03) -> pty.resize(cols, rows)
//   - OUTPUT (0x01) <- pty data, broadcast to all subscribers of the sid
//   - EXIT   (0x07) <- pty exit, then close ws
//
// Out of scope (later tasks): ring buffer / lastSeq replay / RESET (T8 #661),
// PAUSE/RESUME backpressure (T11 #654), multi-session orchestration (T10 #662).

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { createRequire } from 'node:module';
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

import { RingBuffer } from './ring.mjs';

// Maximum payload bytes per OUTPUT replay frame. When backfilling a long
// scrollback we split into chunks of at most REPLAY_CHUNK_BYTES so individual
// ws frames stay reasonable. Each chunk preserves the original seq of its
// LAST byte (matches the live-stream invariant: seq is monotonically
// increasing per OUTPUT frame; replay reuses the original frame seqs by
// concatenating whole frames per chunk).
const REPLAY_CHUNK_BYTES = 64 * 1024;

// T11 #654: per-subscriber pause queue cap. When a paused subscriber's
// queued OUTPUT bytes exceed this, we close its ws with code 1009 (Message
// Too Big) instead of growing memory unbounded. The client can then
// reconnect with `?lastSeq=...` and pick up via the ring-buffer replay
// path — the per-subscriber queue is a transient render-stall buffer, not
// durable state, so dropping it is safe.
const PAUSE_QUEUE_CAP_BYTES = 1 * 1024 * 1024;

// ---- Types --------------------------------------------------------------

export interface PtyLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number | undefined }) => void): void;
}

export type PtyFactory = (opts: {
  cwd: string;
  cols: number;
  rows: number;
}) => PtyLike;

export interface SessionLike {
  sid: string;
  cwd?: string | undefined;
  alive: boolean;
}

interface SubscriberState {
  /** T11 #654: when true, OUTPUT goes to pausedQueue instead of ws.send. */
  paused: boolean;
  /**
   * T11 #654: queued OUTPUT frames captured while paused. We store the
   * pre-encoded ws message (the same Uint8Array we would have sent live)
   * so flush is a straight loop of ws.send — no re-encode. Queue order is
   * preserved (FIFO via array push/iter), which keeps client-visible seq
   * monotonic across the pause/resume boundary.
   */
  pausedQueue: Uint8Array[];
  /** Running byte total of pausedQueue, compared to PAUSE_QUEUE_CAP_BYTES. */
  pausedBytes: number;
}

interface RuntimeSession {
  pty: PtyLike;
  /**
   * T11 #654: subscribers carry per-connection state (pause flag + queue).
   * Map iteration order matches insertion order, which we rely on so the
   * fan-out below is deterministic for tests.
   */
  subscribers: Map<WSWebSocket, SubscriberState>;
  outputSeq: number;
  exited: boolean;
  exitCode: number;
  /** Per-session ring buffer of OUTPUT bytes for lastSeq replay (T8 #661). */
  ring: RingBuffer;
  /** Per-frame seq -> { startSeqOfChunk, originalSeq } not needed; we keep
   *  one ring entry per OUTPUT frame so seq granularity matches frames. */
}

export interface AttachWsOptions {
  /** Pre-shared token (same one passed to createDaemonHttp). */
  token: string;
  /** Stub session map owned by createDaemonHttp. */
  sessions: Map<string, SessionLike>;
  /** PTY factory. Default: real node-pty spawn of `claude`. Tests inject a fake. */
  ptyFactory?: PtyFactory;
  /** Override default 80x24. */
  defaultCols?: number;
  defaultRows?: number;
}

export interface AttachedWs {
  wss: WebSocketServer;
  /** For tests / hot reload: tear down all PTYs + close all subscribers. */
  shutdown(): Promise<void>;
}

// ---- Auth helpers (mirrors auth.mts logic for ws upgrade) ---------------
//
// Why duplicate instead of import requireAuth: requireAuth writes a JSON HTTP
// response, which is incompatible with the ws upgrade flow (we need to write
// raw HTTP error lines and destroy the socket before the ws handshake
// completes). The rules — token equality, allowed origins — are identical and
// share the same constants here.

const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!ALLOWED_ORIGIN_PROTOCOLS.has(url.protocol)) return false;
  return ALLOWED_ORIGIN_HOSTS.has(url.hostname);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  // Write a minimal HTTP/1.1 error line then close. Browsers surface this as
  // a ws connection failure with the status code.
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      '\r\n',
  );
  socket.destroy();
}

// ---- Default PTY factory (real node-pty spawn of `claude`) --------------
//
// Lazy-imported so test environments (and platforms without a node-pty
// prebuild) can swap it via opts.ptyFactory without ever loading the native
// addon.

const defaultPtyFactory: PtyFactory = (opts) => {
  // node-pty is CJS with a native addon; load via createRequire so we stay
  // ESM-pure at the module level and don't pay the load cost (or platform
  // requirement) when tests inject a fake factory.
  const requireCjs = createRequire(import.meta.url);
  const nodePty = requireCjs('node-pty') as typeof import('node-pty');
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'claude.cmd' : 'claude';
  const pty = nodePty.spawn(cmd, [], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
    useConpty: true,
  });
  return {
    write: (d) => pty.write(d),
    resize: (c, r) => pty.resize(c, r),
    kill: (s) => pty.kill(s),
    onData: (cb) => {
      pty.onData(cb);
    },
    onExit: (cb) => {
      pty.onExit(({ exitCode, signal }) => cb({ exitCode, signal }));
    },
  };
};

// ---- attachWebSocket ----------------------------------------------------

export function attachWebSocket(server: HttpServer, opts: AttachWsOptions): AttachedWs {
  const { token, sessions } = opts;
  const ptyFactory = opts.ptyFactory ?? defaultPtyFactory;
  const defaultCols = opts.defaultCols ?? 80;
  const defaultRows = opts.defaultRows ?? 24;

  const wss = new WebSocketServer({ noServer: true });
  // sid -> RuntimeSession (lives only inside the ws layer; created on first
  // ws subscriber for that sid, torn down on PTY exit).
  const runtime = new Map<string, RuntimeSession>();

  // ---- Upgrade handshake: validate token + origin + sid before accepting.
  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      // Not ours — leave it for any other upgrade handler. We do nothing.
      return;
    }

    // 1. Origin check (same allowlist as REST).
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!isAllowedOrigin(origin)) {
      console.warn(`[ccsm/ws] reject origin=${JSON.stringify(origin ?? null)}`);
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    // 2. Token check (query string `?token=...`).
    const presented = url.searchParams.get('token') ?? '';
    if (presented.length === 0 || !constantTimeEquals(presented, token)) {
      console.warn('[ccsm/ws] reject token (mismatch or missing)');
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    // 3. sid lookup.
    const sid = url.searchParams.get('sid') ?? '';
    if (sid.length === 0 || !sessions.has(sid)) {
      console.warn(`[ccsm/ws] reject sid=${JSON.stringify(sid)} (not found)`);
      // ws-spec close codes are advisory at the HTTP layer; we use 4404 in the
      // close frame after handshake, but here pre-handshake we have to use a
      // standard HTTP status. 404 is unambiguous.
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    // 4. Optional lastSeq for replay-on-reconnect (DESIGN.md F4/F6, T8 #661).
    //    Missing / unparseable -> 0 (treat as fresh client, no replay needed).
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

  // ---- Per-connection wiring: subscribe to (or spawn) the runtime session.
  function onConnection(ws: WSWebSocket, sid: string, lastSeq: number): void {
    const sessInfo = sessions.get(sid);
    if (!sessInfo) {
      // Race: session was deleted between upgrade-validation and connection.
      // Send 4404 close (per spec convention) and bail.
      ws.close(4404, 'session_not_found');
      return;
    }

    let rt: RuntimeSession | undefined = runtime.get(sid);
    if (!rt) {
      const spawned = spawnRuntime(sid, sessInfo);
      if (!spawned) {
        ws.close(1011, 'pty_spawn_failed');
        return;
      }
      rt = spawned;
    }

    // Already exited? Send EXIT immediately, close.
    if (rt.exited) {
      try {
        ws.send(encodeFrame({ type: FrameType.EXIT, seq: rt.outputSeq, payload: encodeExit(rt.exitCode) }));
      } catch {
        // ignore
      }
      ws.close(1000, 'exited');
      return;
    }

    // T8 #661: lastSeq replay. Must happen BEFORE adding ws to subscribers,
    // so we don't interleave replayed bytes with a freshly-arriving live OUTPUT
    // (PTY data callback iterates rt.subscribers).
    if (lastSeq < rt.outputSeq) {
      const replay = rt.ring.range(lastSeq + 1, rt.outputSeq);
      if (replay === null) {
        // Asked-for seq has been evicted from the ring. Tell the client to
        // clear its scrollback before live OUTPUT resumes (DESIGN.md §5 RESET).
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
        // Send replayed bytes. We re-emit as OUTPUT frames carrying rt.outputSeq
        // (the seq of the latest byte). Splitting into <= REPLAY_CHUNK_BYTES
        // chunks keeps individual ws messages bounded; each chunk's seq is the
        // *seq of its last byte* in the original stream — but since we don't
        // track per-byte seqs (only per-frame), we approximate by sending the
        // whole replay window with seq=rt.outputSeq for the LAST chunk and
        // intermediate chunks with the same seq (client uses lastSeq=outputSeq
        // after replay, intermediate seqs are not consulted by the reconnect
        // logic — only the final live-stream seq matters).
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
      // lastSeq === rt.outputSeq: nothing to replay; fall through.
    }
    // (lastSeq >= rt.outputSeq with strictly greater: caller is "ahead" of
    // server, which only happens after a daemon restart with state loss; we
    // simply enter live mode with no replay.)

    rt.subscribers.set(ws, { paused: false, pausedQueue: [], pausedBytes: 0 });

    ws.on('message', (raw, isBinary) => {
      if (!isBinary) {
        // Spec: only binary frames after handshake. Drop.
        return;
      }
      let buf: Uint8Array;
      if (raw instanceof Buffer) {
        buf = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else if (Array.isArray(raw)) {
        // ws can deliver Buffer[] for fragmented messages.
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
      handleClientFrame(rt!, ws, frame.type, frame.payload);
    });

    const cleanup = (): void => {
      rt!.subscribers.delete(ws);
      // Spec note: do NOT kill PTY when subscriber set goes empty in T4.
      // (Future: keep-alive policy; current daemon lives only for active
      //  user — letting PTY linger lets the user reload the page without
      //  losing their REPL state.) But reviewer asked: ws.mts on close
      //  should clean its OWN pty if subscribers empty? Re-read spec…
      //  "ws 关掉时清理 pty (kill SIGTERM, 2s 后 SIGKILL)" — so YES, kill
      //  on last subscriber leaving. Implement that here.
      if (rt!.subscribers.size === 0 && !rt!.exited) {
        killRuntime(sid, rt!);
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
        // node-pty.write expects string. Frontend sends UTF-8 bytes.
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
        // T11 #654: gate OUTPUT to this subscriber. Other subscribers (and
        // the ring buffer) are unaffected — pause is per-connection.
        const state = rt.subscribers.get(ws);
        if (state) state.paused = true;
        break;
      }
      case FrameType.RESUME: {
        // T11 #654: flush queued OUTPUT in original order, clear queue, then
        // return to live forwarding. We send pre-encoded frames as-is so seq
        // values stay monotonic at the wire level.
        const state = rt.subscribers.get(ws);
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
        // OUTPUT/EXIT/RESET are server-to-client; reject anything else.
        console.warn(`[ccsm/ws] ignoring c->s frame type=0x${type.toString(16)}`);
    }
  }

  function spawnRuntime(sid: string, info: SessionLike): RuntimeSession | null {
    let pty: PtyLike;
    try {
      pty = ptyFactory({
        cwd: info.cwd ?? process.cwd(),
        cols: defaultCols,
        rows: defaultRows,
      });
    } catch (err) {
      console.error(`[ccsm/ws] pty spawn failed for sid=${sid}:`, (err as Error).message);
      return null;
    }
    const rt: RuntimeSession = {
      pty,
      subscribers: new Map(),
      outputSeq: 0,
      exited: false,
      exitCode: 0,
      ring: new RingBuffer(),
    };
    runtime.set(sid, rt);

    pty.onData((data) => {
      const payload = Buffer.from(data, 'utf8');
      const payloadView = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      rt.outputSeq = (rt.outputSeq + 1) >>> 0;
      // T8 #661: persist OUTPUT bytes in ring buffer for lastSeq replay.
      // ring.append() may evict older frames silently — that's fine; future
      // reconnects with a too-old lastSeq will get RESET (handled in
      // onConnection above).
      rt.ring.append(rt.outputSeq, payloadView);
      const frame = encodeFrame({
        type: FrameType.OUTPUT,
        seq: rt.outputSeq,
        payload: payloadView,
      });
      // Snapshot subscribers — sends in this microtask shouldn't be perturbed
      // by concurrent close handlers mutating the Map. T11 #654: paused
      // subscribers buffer the pre-encoded frame instead of sending; if their
      // queue exceeds PAUSE_QUEUE_CAP_BYTES we close with 1009 (the client
      // can reconnect with lastSeq and pick up via the ring buffer).
      for (const [ws, state] of Array.from(rt.subscribers.entries())) {
        if (ws.readyState !== ws.OPEN) continue;
        if (state.paused) {
          state.pausedQueue.push(frame);
          state.pausedBytes += frame.byteLength;
          if (state.pausedBytes > PAUSE_QUEUE_CAP_BYTES) {
            // Cap exceeded — drop the queue and disconnect this subscriber.
            // 1009 = "Message Too Big" (RFC 6455 §7.4.1), the closest
            // standard code; reason is human-readable for logs/devtools.
            state.pausedQueue = [];
            state.pausedBytes = 0;
            try {
              ws.close(1009, 'pause_queue_overflow');
            } catch {
              // ignore — close racing with another teardown is fine.
            }
          }
          continue;
        }
        try {
          ws.send(frame);
        } catch (err) {
          console.warn('[ccsm/ws] ws.send failed:', (err as Error).message);
        }
      }
    });

    pty.onExit(({ exitCode }) => {
      // Normalize exit code: u32 only. Signal-killed PTYs sometimes report -1.
      const code = exitCode < 0 ? 0xffffffff : (exitCode >>> 0);
      rt.exited = true;
      rt.exitCode = code;
      rt.outputSeq = (rt.outputSeq + 1) >>> 0;
      const frame = encodeFrame({
        type: FrameType.EXIT,
        seq: rt.outputSeq,
        payload: encodeExit(code),
      });
      // T11 #654 note: EXIT is a terminal signal and bypasses any per-
      // subscriber pause queue — the PTY is gone and there will be no more
      // OUTPUT, so there is nothing meaningful to flush first. Clients
      // currently in the paused state simply receive EXIT next; their
      // pausedQueue is dropped along with the runtime.
      for (const ws of Array.from(rt.subscribers.keys())) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(frame);
          } catch {
            // ignore
          }
          ws.close(1000, 'exited');
        }
      }
      // Mark the stub session as not-alive so subsequent REST GET reflects state.
      const live = sessions.get(sid);
      if (live) live.alive = false;
      runtime.delete(sid);
    });

    return rt;
  }

  function killRuntime(sid: string, rt: RuntimeSession): void {
    if (rt.exited) return;
    try {
      rt.pty.kill('SIGTERM');
    } catch (err) {
      console.warn(`[ccsm/ws] kill SIGTERM sid=${sid}:`, (err as Error).message);
    }
    const t = setTimeout(() => {
      if (!rt.exited) {
        try {
          rt.pty.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 2000);
    t.unref();
  }

  // ---- shutdown -----------------------------------------------------------

  async function shutdown(): Promise<void> {
    server.removeListener('upgrade', onUpgrade);
    for (const [sid, rt] of Array.from(runtime.entries())) {
      for (const ws of Array.from(rt.subscribers.keys())) {
        try {
          ws.close(1001, 'going_away');
        } catch {
          // ignore
        }
      }
      killRuntime(sid, rt);
    }
    runtime.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return { wss, shutdown };
}
