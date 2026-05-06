// WebSocket client for one PTY session. MVP scope (Task #658 / T6):
//   - Connect to `/ws?sid=...&token=...` on the same origin (vite proxies in dev,
//     daemon serves both in prod — see DESIGN.md §F4).
//   - Decode incoming binary frames, route OUTPUT to a callback and EXIT to a
//     teardown callback.
//   - Encode outgoing INPUT / RESIZE frames.
//
// Out of scope here (left to T8 daemon + later frontend tasks):
//   - lastSeq / ring-buffer replay
//   - RESET handling
//   - PAUSE / RESUME backpressure
//   - reconnect with exponential backoff
//
// We intentionally use the browser-native WebSocket; no third-party ws lib.

import {
  FrameType,
  decodeExit,
  decodeFrame,
  encodeFrame,
  encodeResize,
} from '@ccsm/shared';
import { API_PATHS } from '@ccsm/shared';

export type WsStatus =
  | 'idle'
  | 'connecting'
  | 'attached'
  | 'disconnected'
  | 'exited';

export interface WsClientOptions {
  sid: string;
  token: string;
  /** Override for tests. Defaults to global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  onOutput?: (data: Uint8Array) => void;
  onExit?: (code: number) => void;
  onStatusChange?: (status: WsStatus) => void;
  /** Called for ws.onerror or ws.onclose without a prior EXIT frame. */
  onDisconnect?: (reason: string) => void;
}

/**
 * Build the ws URL for the current page. Uses same-origin so the vite dev
 * proxy (`/ws` → 127.0.0.1:17832) and the daemon's own static-server path both
 * work without configuration. Falls back gracefully when `window` is missing
 * (e.g. unit tests in jsdom may stub location, but never undefine it).
 */
export function buildWsUrl(sid: string, token: string): string {
  const loc =
    typeof window !== 'undefined' && window.location
      ? window.location
      : ({ protocol: 'http:', host: '127.0.0.1' } as Location);
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ sid, token });
  return `${wsProto}//${loc.host}${API_PATHS.ws}?${params.toString()}`;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private status: WsStatus = 'idle';
  private exitSeen = false;
  private inputSeq = 0;
  // Buffer for a RESIZE requested before the socket reaches OPEN. The daemon
  // would otherwise keep node-pty's default 80x24 until the user happens to
  // resize the window. Only the latest size matters, so we coalesce.
  private pendingResize: { cols: number; rows: number } | null = null;

  constructor(private readonly opts: WsClientOptions) {}

  getStatus(): WsStatus {
    return this.status;
  }

  connect(): void {
    if (this.ws) return; // idempotent — caller already connected
    const Ctor = this.opts.WebSocketImpl ?? WebSocket;
    const url = buildWsUrl(this.opts.sid, this.opts.token);
    const ws = new Ctor(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setStatus('connecting');

    ws.onopen = () => {
      this.setStatus('attached');
      if (this.pendingResize) {
        const { cols, rows } = this.pendingResize;
        this.pendingResize = null;
        this.sendResize(cols, rows);
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(ev.data);
    };
    ws.onerror = () => {
      // Browser ws errors don't expose detail; surface a generic reason.
      if (!this.exitSeen) {
        this.opts.onDisconnect?.('ws error');
      }
    };
    ws.onclose = () => {
      // EXIT path already transitioned status; don't clobber it.
      if (!this.exitSeen) {
        this.setStatus('disconnected');
        this.opts.onDisconnect?.('ws closed');
      }
      this.ws = null;
    };
  }

  /** Send raw user input as one INPUT frame. No-op if not yet attached. */
  sendInput(data: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    const payload = new TextEncoder().encode(data);
    const frame = encodeFrame({
      type: FrameType.INPUT,
      seq: this.nextSeq(),
      payload,
    });
    ws.send(frame);
  }

  /**
   * Send a RESIZE frame. If the socket has not yet reached OPEN we buffer
   * the latest size and flush it from `onopen`, so the very first resize
   * (the one that carries the real viewport dimensions) always reaches the
   * daemon instead of being silently dropped.
   */
  sendResize(cols: number, rows: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      this.pendingResize = { cols, rows };
      return;
    }
    const payload = encodeResize(cols, rows);
    const frame = encodeFrame({
      type: FrameType.RESIZE,
      seq: this.nextSeq(),
      payload,
    });
    ws.send(frame);
    this.pendingResize = null;
  }

  close(): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // already closing — ignore
    }
  }

  // ---- internals ----

  private handleMessage(raw: unknown): void {
    let buf: Uint8Array;
    if (raw instanceof ArrayBuffer) {
      buf = new Uint8Array(raw);
    } else if (raw instanceof Uint8Array) {
      buf = raw;
    } else {
      // Server should never send text in this protocol; ignore defensively.
      return;
    }
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch {
      // Malformed frame — best-effort drop. T8/T11 may add structured logging.
      return;
    }
    switch (frame.type) {
      case FrameType.OUTPUT:
        this.opts.onOutput?.(frame.payload);
        break;
      case FrameType.EXIT: {
        const { code } = decodeExit(frame.payload);
        this.exitSeen = true;
        this.setStatus('exited');
        this.opts.onExit?.(code);
        this.close();
        break;
      }
      // RESET / PAUSE / RESUME deferred to later tasks. Frontend never receives
      // INPUT / RESIZE.
      default:
        break;
    }
  }

  private setStatus(s: WsStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatusChange?.(s);
  }

  private nextSeq(): number {
    // Client-side seq is informational only (see DESIGN.md §5). Wrap at u32.
    const next = this.inputSeq;
    this.inputSeq = (this.inputSeq + 1) >>> 0;
    return next;
  }
}
