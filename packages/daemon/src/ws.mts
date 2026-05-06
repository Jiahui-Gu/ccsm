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

interface RuntimeSession {
  pty: PtyLike;
  subscribers: Set<WSWebSocket>;
  outputSeq: number;
  exited: boolean;
  exitCode: number;
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, sid);
    });
  };

  server.on('upgrade', onUpgrade);

  // ---- Per-connection wiring: subscribe to (or spawn) the runtime session.
  function onConnection(ws: WSWebSocket, sid: string): void {
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

    rt.subscribers.add(ws);

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
      handleClientFrame(rt!, frame.type, frame.payload);
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

  function handleClientFrame(rt: RuntimeSession, type: FrameType, payload: Uint8Array): void {
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
      case FrameType.PAUSE:
      case FrameType.RESUME:
        // T11 #654 will wire these; silently accept now.
        break;
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
      subscribers: new Set(),
      outputSeq: 0,
      exited: false,
      exitCode: 0,
    };
    runtime.set(sid, rt);

    pty.onData((data) => {
      const payload = Buffer.from(data, 'utf8');
      rt.outputSeq = (rt.outputSeq + 1) >>> 0;
      const frame = encodeFrame({
        type: FrameType.OUTPUT,
        seq: rt.outputSeq,
        payload: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
      });
      // Snapshot subscribers — sends in this microtask shouldn't be perturbed
      // by concurrent close handlers mutating the Set.
      for (const ws of Array.from(rt.subscribers)) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(frame);
          } catch (err) {
            console.warn('[ccsm/ws] ws.send failed:', (err as Error).message);
          }
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
      for (const ws of Array.from(rt.subscribers)) {
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
      for (const ws of Array.from(rt.subscribers)) {
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
