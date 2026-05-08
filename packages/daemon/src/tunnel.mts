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
//     Until hello arrives, raw passthrough is gated: binary frames and
//     non-JSON text before hello → close 1008. JSON `{type:"http_req"}`
//     control frames (Task #787) are accepted before hello — they're
//     injected by the DO regardless of browser pairing and carry no browser
//     token by design (Task #789, S3-D).
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
   * Loopback HTTP port the daemon is listening on. Used by the HTTP-over-
   * tunnel path (Task #787, S3-C): incoming `http_req` control frames are
   * fetched against `http://127.0.0.1:<port><path>` and the response is
   * serialized back as an `http_res` control frame on the same ws. Pass 0
   * to disable HTTP mux (tests / configs that only exercise raw ws).
   */
  daemonLoopbackPort?: number;
  /**
   * DI seam for tests. Real code uses the default which constructs a real
   * `ws.WebSocket`. Tests inject a fake socket that implements WsLike.
   */
  wsFactory?: WsFactory;
  /**
   * DI seam for tests. Defaults to `globalThis.fetch` (Node 22). Tests
   * inject a stub so we can drive http_req → http_res without binding a
   * real loopback server.
   */
  fetchImpl?: typeof fetch;
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

/**
 * HTTP-over-tunnel control frames (Task #787, S3-C). Mux the loopback REST
 * surface over the same daemon-dialed ws so cloud browsers can hit
 * `cc-sm.pages.dev/api/*` without a direct path to the NAT'd daemon.
 */
interface HttpReqFrame {
  type: 'http_req';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body_b64: string;
}

interface HttpResFrame {
  type: 'http_res';
  id: string;
  status: number;
  headers: Record<string, string>;
  body_b64: string;
}

function parseHttpReq(parsed: Record<string, unknown>): HttpReqFrame | null {
  if (parsed.type !== 'http_req') return null;
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
  if (typeof parsed.method !== 'string') return null;
  if (typeof parsed.path !== 'string') return null;
  if (typeof parsed.body_b64 !== 'string') return null;
  if (parsed.headers === null || typeof parsed.headers !== 'object') return null;
  // Trust the DO; we already shape-checked the surface fields.
  return parsed as unknown as HttpReqFrame;
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
  private readonly daemonLoopbackPort: number;
  private readonly fetchImpl: typeof fetch;

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
    this.daemonLoopbackPort = opts.daemonLoopbackPort ?? 0;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
      // Hello-gate (Task #782): a browser-paired daemon expects the FIRST
      // text frame to be `{type:"hello",token}` so the daemon can authorize
      // browser-bound raw OUTPUT/INPUT passthrough. Binary or non-JSON text
      // before hello → 1008 (frame is NOT forwarded to onFrame).
      //
      // Task #789, S3-D: HTTP-over-tunnel control frames (`http_req`) are
      // injected by the DO regardless of whether a browser is paired (the
      // browser may hit `/api/*` directly without ever opening a /ws/default
      // session). Those frames carry no browser token by design — the DO
      // already gates HTTP entry — so they MUST be accepted before hello.
      // We sniff text frames for `{type:"http_req"}` first; only "neither
      // hello nor http_req" lands on the rejectHello path.
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
        const ctrl = this.tryParseHttpReq(text);
        if (ctrl !== null) {
          // http_req is browser-pairing-independent; handle without flipping
          // helloSeen so a subsequent browser pairing still requires hello.
          void this.handleHttpReq(ctrl);
          return;
        }
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
        const text = buf.toString('utf8');
        // Task #787: try to parse text frame as an http_req control frame
        // before falling through to the raw S3-T6 OUTPUT/INPUT path. We only
        // consider it a control frame if it parses as JSON with `type:
        // "http_req"`; everything else (raw text output, frames lacking
        // `type`) flows through onFrame untouched.
        const ctrl = this.tryParseHttpReq(text);
        if (ctrl !== null) {
          void this.handleHttpReq(ctrl);
          return;
        }
        this.onFrame(text);
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

  private tryParseHttpReq(text: string): HttpReqFrame | null {
    if (text.length === 0 || text.charCodeAt(0) !== 0x7b /* '{' */) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    return parseHttpReq(parsed as Record<string, unknown>);
  }

  /**
   * Handle an inbound `http_req` frame: fetch the daemon's loopback HTTP
   * server, serialize the response as `http_res`, send back on the same ws.
   * Errors map to status 502 with text/plain body so the browser sees a
   * deterministic upstream error instead of a hung request.
   */
  private async handleHttpReq(frame: HttpReqFrame): Promise<void> {
    if (this.daemonLoopbackPort === 0) {
      this.send(JSON.stringify({
        type: 'http_res',
        id: frame.id,
        status: 503,
        headers: { 'content-type': 'text/plain' },
        body_b64: Buffer.from('http-over-tunnel disabled (no loopback port)').toString('base64'),
      } satisfies HttpResFrame));
      return;
    }
    const url = `http://127.0.0.1:${this.daemonLoopbackPort}${frame.path}`;
    const body = frame.body_b64.length > 0
      ? Buffer.from(frame.body_b64, 'base64')
      : undefined;
    // Strip hop-by-hop headers + the inbound Host so loopback fetch picks the
    // right one. `content-length` will be recomputed by undici.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(frame.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
      headers[k] = v;
    }
    console.error(`[ccsm] tunnel: rx http_req ${frame.method} ${frame.path}`);
    let response: globalThis.Response;
    try {
      const init: RequestInit = {
        method: frame.method,
        headers,
        redirect: 'manual',
      };
      if (body !== undefined) {
        init.body = body;
      }
      response = await this.fetchImpl(url, init);
    } catch (err) {
      this.send(JSON.stringify({
        type: 'http_res',
        id: frame.id,
        status: 502,
        headers: { 'content-type': 'text/plain' },
        body_b64: Buffer.from(`upstream error: ${(err as Error).message}`).toString('base64'),
      } satisfies HttpResFrame));
      return;
    }
    const resHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const resBody = Buffer.from(await response.arrayBuffer());
    this.send(JSON.stringify({
      type: 'http_res',
      id: frame.id,
      status: response.status,
      headers: resHeaders,
      body_b64: resBody.toString('base64'),
    } satisfies HttpResFrame));
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
