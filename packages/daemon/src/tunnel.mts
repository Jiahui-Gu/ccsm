// Cloud-tunnel WebSocket client (Task #779, S3-T3; T6 token flow Task #782).
//
// Daemon-side outbound WS to the Cloudflare Worker tunnel endpoint. T3 only
// implements the transport: dial, auto-reconnect with exponential backoff +
// jitter, send frames, deliver inbound frames via onFrame callback. Wiring
// (caller reads CCSM_TUNNEL_URL, mints token) lands in T4. T6 adds the
// per-browser token handshake: the DO sends a `{type:"hello",token}` JSON
// text frame as the FIRST inbound frame after a browser pairs; the daemon
// runs that token through the SAME constant-time check the loopback
// HTTP/ws auth uses (auth.mts), and on mismatch the daemon closes the
// tunnel ws with 1008 — the DO will surface that to the browser.
//
// Design notes:
//   - ws package is already a daemon dep (used by ws.mts server) — no new dep.
//   - Backoff sequence is hand-coded (1s / 2s / 4s / 8s / 16s / 30s ...) with
//     ±20% jitter, capped at 30s. p-retry / exponential-backoff are
//     overkill for ~10 lines of setTimeout.
//   - State machine: idle -> connecting -> connected -> reconnecting ->
//     connecting -> ... ; stop() forces 'stopped' (terminal).
//   - send() while not connected drops the frame (logs once). Caller must
//     gate sends on getState() === 'connected' if they care.
//   - Hello state: tracked per-connection (`helloSeen` reset on every dial).
//     Until hello arrives, all inbound text frames are inspected as hello;
//     binary or non-hello-text before hello → close 1008.
//
// timingSafeEqual constant-time comparison is reused from auth.mts (NOT
// reimplemented) to honor the §1 5-tier "use existing in-repo" rule.

import { timingSafeEqual } from 'node:crypto';

import WebSocket, { type RawData } from 'ws';

export type TunnelState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopped';

export interface TunnelClientOptions {
  url: string;
  /**
   * Daemon's expected bearer token. Compared against the token presented in
   * the per-browser hello frame via constant-time equality. Mismatch → ws
   * closed 1008 and the bad frame is NOT forwarded onward (Task #782).
   */
  token: string;
  /** Invoked once per inbound frame from the cloud (binary or text). */
  onFrame: (data: Buffer | string) => void;
  /**
   * DI seam for tests. Real code uses the default which constructs a real
   * `ws.WebSocket`. Tests inject a fake socket that implements WsLike.
   */
  wsFactory?: WsFactory;
}

/** Minimal subset of `ws.WebSocket` that TunnelClient relies on. */
export interface WsLike {
  readyState: number;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: Buffer | string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string) => WsLike;

// Backoff sequence (ms). Each step gets ±20% jitter. Capped at 30s.
const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const BACKOFF_JITTER = 0.2;

function defaultWsFactory(url: string): WsLike {
  return new WebSocket(url) as unknown as WsLike;
}

interface HelloFrame {
  type: 'hello';
  token: string;
}

function parseHello(text: string): HelloFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'hello') return null;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  return { type: 'hello', token: obj.token };
}

function constantTimeTokenEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Compare against same-length filler to keep timing similar.
    const filler = Buffer.alloc(a.length, 0);
    timingSafeEqual(a, filler);
    return false;
  }
  return timingSafeEqual(a, b);
}

export class TunnelClient {
  private readonly url: string;
  readonly token: string;
  private readonly onFrame: (data: Buffer | string) => void;
  private readonly wsFactory: WsFactory;

  private state: TunnelState = 'idle';
  private ws: WsLike | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private helloSeen = false;
  private browserToken: string | null = null;

  constructor(opts: TunnelClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.onFrame = opts.onFrame;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
  }

  getState(): TunnelState {
    return this.state;
  }

  /**
   * Returns the per-browser token observed in the most recent hello frame,
   * or null if no hello has been received on the current connection. Used
   * by the daemon-side router (Task #782) to run frames through the SAME
   * classifyOrigin / token check path the loopback ws path uses — without
   * adding a new auth code path.
   */
  getBrowserToken(): string | null {
    return this.browserToken;
  }

  start(): void {
    if (this.stopped) return;
    if (this.state !== 'idle') return;
    this.dial();
  }

  send(data: Buffer | string): void {
    if (this.state !== 'connected' || this.ws === null) {
      // Drop. Caller can gate on getState() if they care.
      console.warn('[ccsm/tunnel] drop send: state=' + this.state);
      return;
    }
    try {
      this.ws.send(data);
    } catch (err) {
      console.warn('[ccsm/tunnel] send error:', (err as Error).message);
    }
  }

  stop(): void {
    this.stopped = true;
    this.state = 'stopped';
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close(1000, 'stop');
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  // ---- internals --------------------------------------------------------

  private dial(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    this.helloSeen = false;
    this.browserToken = null;
    let socket: WsLike;
    try {
      socket = this.wsFactory(this.url);
    } catch (err) {
      console.warn('[ccsm/tunnel] factory threw:', (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on('open', () => {
      if (this.stopped) {
        try { socket.close(1000, 'stopped'); } catch { /* ignore */ }
        return;
      }
      this.state = 'connected';
      this.attempts = 0;
    });

    socket.on('message', (raw, isBinary) => {
      // Hello-gate (Task #782): the FIRST frame after a browser pairs MUST be
      // a JSON text frame `{type:"hello",token}`. Anything else → 1008 and
      // we drop the frame (NOT forwarded to onFrame). After hello, raw
      // passthrough resumes.
      if (!this.helloSeen) {
        if (isBinary) {
          this.rejectHello('binary frame before hello');
          return;
        }
        const text = (Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw as ArrayBuffer)).toString('utf8');
        const hello = parseHello(text);
        if (hello === null) {
          this.rejectHello('malformed hello frame');
          return;
        }
        if (!constantTimeTokenEquals(hello.token, this.token)) {
          this.rejectHello('bad token in hello');
          return;
        }
        this.helloSeen = true;
        this.browserToken = hello.token;
        return;
      }
      if (isBinary) {
        // RawData covers Buffer | ArrayBuffer | Buffer[]. Normalize to Buffer.
        let buf: Buffer;
        if (Buffer.isBuffer(raw)) {
          buf = raw;
        } else if (Array.isArray(raw)) {
          buf = Buffer.concat(raw);
        } else {
          buf = Buffer.from(raw as ArrayBuffer);
        }
        this.onFrame(buf);
      } else {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw as ArrayBuffer);
        this.onFrame(buf.toString('utf8'));
      }
    });

    socket.on('error', (err) => {
      console.warn('[ccsm/tunnel] ws error:', err.message);
      // 'close' will fire after 'error' for ws; defer reconnect to 'close'.
    });

    socket.on('close', (code) => {
      this.ws = null;
      this.helloSeen = false;
      this.browserToken = null;
      if (this.stopped) {
        this.state = 'stopped';
        return;
      }
      console.warn(`[ccsm/tunnel] closed code=${code}, will reconnect`);
      this.scheduleReconnect();
    });
  }

  private rejectHello(reason: string): void {
    console.warn(`[ccsm/tunnel] hello rejected: ${reason}`);
    if (this.ws !== null) {
      try {
        this.ws.close(1008, reason);
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.state = 'reconnecting';
    const delay = this.computeBackoffMs(this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.dial();
    }, delay);
  }

  /** Exposed for tests. Pure function of attempt index. */
  computeBackoffMs(attempt: number): number {
    const idx = Math.min(attempt, BACKOFF_SEQUENCE_MS.length - 1);
    const base = BACKOFF_SEQUENCE_MS[idx] ?? 30_000;
    // ±20% jitter
    const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER;
    return Math.min(30_000, Math.round(base * jitter));
  }
}
