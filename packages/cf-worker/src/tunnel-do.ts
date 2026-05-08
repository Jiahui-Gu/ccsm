import type { Env } from './index';

interface PairedSockets {
  browser?: WebSocket | undefined;
  daemon?: WebSocket | undefined;
}

/** Subprotocol prefix matching frontend-web/src/hostConfig.ts (Task #782). */
const WS_SUBPROTOCOL_PREFIX = 'ccsm.';

/**
 * HTTP-over-tunnel timeout. Cloudflare Worker subrequest cap is 30s; we
 * reject in-flight HTTP requests after that with 504 so the browser sees a
 * deterministic upstream timeout instead of a Worker eviction.
 */
const HTTP_OVER_TUNNEL_TIMEOUT_MS = 30_000;

/**
 * Hello control frame the DO injects ahead of any browser→daemon traffic so
 * the daemon can run the browser-presented token through its existing
 * classifyOrigin / token check path (Task #782, S3-T6).
 *
 * Wire format: JSON text frame `{"type":"hello","token":"<t>"}`. Subsequent
 * frames are raw passthrough. The daemon side parses ONLY the first text
 * frame as hello; if it's missing or malformed the daemon closes 1008.
 */
interface HelloFrame {
  type: 'hello';
  token: string;
}

/**
 * HTTP-over-tunnel frames (Task #787, S3-C). Mux REST `/api/*` + `/token`
 * over the same daemon-dialed ws so the browser only ever talks to
 * cc-sm.pages.dev. Distinguished from S3-T6 raw OUTPUT/INPUT frames by the
 * `type` field — raw frames are binary OR text without a JSON `type`.
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

interface PendingHttp {
  resolve: (res: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

function buildHelloFrame(token: string): string {
  const frame: HelloFrame = { type: 'hello', token };
  return JSON.stringify(frame);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunk to avoid blowing argument count limits on big payloads.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parse a daemon-bound text frame as an http_res control frame. Returns null
 * for raw text (S3-T6 OUTPUT passthrough) so the caller falls through to the
 * existing browser-forward path.
 */
function tryParseControlFrame(text: string): HttpResFrame | null {
  if (text.length === 0 || text.charCodeAt(0) !== 0x7b /* '{' */) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'http_res') return null;
  if (typeof obj.id !== 'string') return null;
  if (typeof obj.status !== 'number') return null;
  if (typeof obj.body_b64 !== 'string') return null;
  if (obj.headers === null || typeof obj.headers !== 'object') return null;
  return parsed as HttpResFrame;
}

/**
 * Extract the daemon bearer token from a browser ws upgrade.
 *
 * Browsers cannot set custom headers on `new WebSocket(url, protocols)`, so
 * the SPA encodes the token as `ccsm.<token>` in the Sec-WebSocket-Protocol
 * request header (RFC 6455 §1.9). The header is a comma-separated list of
 * subprotocol tokens; we take the first `ccsm.*` entry.
 *
 * Returns null when the header is absent / malformed / has no ccsm.* entry.
 * The DO will close the browser socket with 1008 in that case.
 */
function extractBrowserToken(req: Request): { token: string; protocol: string } | null {
  const raw = req.headers.get('sec-websocket-protocol');
  if (raw === null) return null;
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const entry of entries) {
    if (entry.startsWith(WS_SUBPROTOCOL_PREFIX)) {
      const token = entry.slice(WS_SUBPROTOCOL_PREFIX.length);
      if (token.length > 0) return { token, protocol: entry };
    }
  }
  return null;
}

/**
 * TunnelDO pairs a daemon websocket with a browser websocket and forwards
 * frames between them in both directions.
 *
 * Routes (path is whatever the worker forwards; we match suffix only):
 *   /tunnel/default — daemon dials in (long-lived).
 *   /ws/default     — browser connects; closes 1011 if no daemon paired yet.
 *   /api/*, /token  — HTTP request multiplexed over the daemon ws (Task #787).
 *
 * Lifecycle:
 *   - On browser pair: DO extracts token from Sec-WebSocket-Protocol header,
 *     stores it on `browserToken`, echoes the same protocol on the 101
 *     response (RFC 6455 §4.2.2 — browser rejects the handshake otherwise),
 *     and emits a hello control frame `{type:"hello",token}` to the daemon
 *     before any browser->daemon raw forwarding (Task #782, S3-T6).
 *   - Frames (text + binary) after hello are forwarded as-is via ws.send.
 *     Text frames that parse as http_res control frames are routed to the
 *     pending HTTP request map instead of forwarded raw (Task #787, S3-C).
 *   - daemon close/error → browser closed with 1006/1011, both slots cleared
 *     so a fresh daemon can re-pair. Pending HTTP requests reject → 502.
 *   - browser close → daemon stays alive; next browser can re-pair. Token
 *     state is reset so a fresh browser gets re-authed.
 *
 * S3-T2 (Task #774). Token plumbing S3-T6 (Task #782). HTTP mux S3-C (Task #787).
 */
export class TunnelDO {
  private state: DurableObjectState;
  private env: Env;
  private sockets: PairedSockets = {};
  private browserToken: string | null = null;
  private pendingHttp = new Map<string, PendingHttp>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    void this.state;
    void this.env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const upgrade = req.headers.get('Upgrade');

    // HTTP-over-tunnel (Task #787): /api/* and /token are NOT ws upgrades —
    // they're regular requests muxed over the daemon ws as control frames.
    if (
      upgrade?.toLowerCase() !== 'websocket' &&
      (url.pathname.startsWith('/api/') || url.pathname === '/token')
    ) {
      return this.proxyHttp(req);
    }

    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    if (url.pathname.endsWith('/tunnel/default')) {
      server.accept();
      this.sockets.daemon = server;
      this.wireDaemon(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/ws/default')) {
      if (!this.sockets.daemon) {
        server.accept();
        server.close(1011, 'daemon offline');
        return new Response(null, { status: 101, webSocket: client });
      }
      // Task #782: extract + stash browser token; emit hello to daemon so the
      // daemon can authorize before any forwarded frame.
      const extracted = extractBrowserToken(req);
      if (extracted === null) {
        server.accept();
        server.close(1008, 'missing token subprotocol');
        return new Response(null, { status: 101, webSocket: client });
      }
      this.browserToken = extracted.token;
      server.accept();
      this.sockets.browser = server;
      this.wireBrowser(server);
      // Emit hello as the first daemon-bound frame. Synchronous send is fine
      // here — the daemon ws is already accepted and we're inside the DO's
      // single-threaded request handler.
      try {
        this.sockets.daemon?.send(buildHelloFrame(extracted.token));
      } catch {
        /* daemon may have just dropped; close browser, slots clean up via daemon close */
      }
      // Echo the chosen subprotocol on the 101 response so the browser
      // accepts the handshake (RFC 6455 §4.2.2 step 4).
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': extracted.protocol },
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  /** Test-only accessor for the currently-paired browser token. */
  getBrowserTokenForTest(): string | null {
    return this.browserToken;
  }

  /** Test-only accessor for in-flight HTTP request count. */
  getPendingHttpCountForTest(): number {
    return this.pendingHttp.size;
  }

  /**
   * Serialize a regular HTTP request into an http_req control frame, send it
   * on the daemon ws, and await the matching http_res. 30s timeout → 504.
   * Daemon offline → 503 immediately. Daemon drop while pending → 502.
   */
  private async proxyHttp(req: Request): Promise<Response> {
    if (!this.sockets.daemon) {
      return new Response('daemon offline', { status: 503 });
    }
    const id = crypto.randomUUID();
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await req.arrayBuffer();
    const body_b64 = body.byteLength === 0 ? '' : arrayBufferToBase64(body);
    const frame: HttpReqFrame = {
      type: 'http_req',
      id,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      body_b64,
    };
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingHttp.delete(id)) {
          resolve(new Response('upstream timeout', { status: 504 }));
        }
      }, HTTP_OVER_TUNNEL_TIMEOUT_MS);
      this.pendingHttp.set(id, { resolve, timer });
      try {
        this.sockets.daemon!.send(JSON.stringify(frame));
      } catch {
        clearTimeout(timer);
        this.pendingHttp.delete(id);
        resolve(new Response('upstream send failed', { status: 502 }));
      }
    });
  }

  /** Reject every in-flight HTTP request when the daemon ws drops. */
  private failAllPendingHttp(status: number, body: string): void {
    for (const [, pending] of this.pendingHttp) {
      clearTimeout(pending.timer);
      pending.resolve(new Response(body, { status }));
    }
    this.pendingHttp.clear();
  }

  /** Resolve a pending HTTP request from a parsed http_res control frame. */
  private completeHttpRes(frame: HttpResFrame): void {
    const pending = this.pendingHttp.get(frame.id);
    if (pending === undefined) return;
    this.pendingHttp.delete(frame.id);
    clearTimeout(pending.timer);
    const bytes = frame.body_b64.length === 0
      ? new Uint8Array(0)
      : base64ToUint8Array(frame.body_b64);
    pending.resolve(
      new Response(bytes as unknown as BodyInit, {
        status: frame.status,
        headers: frame.headers,
      }),
    );
  }

  private wireDaemon(ws: WebSocket): void {
    ws.addEventListener('message', (ev: MessageEvent) => {
      // Inspect text frames for control-frame envelopes (Task #787).
      // Binary frames + non-control text fall through to browser passthrough.
      if (typeof ev.data === 'string') {
        const ctrl = tryParseControlFrame(ev.data);
        if (ctrl !== null) {
          this.completeHttpRes(ctrl);
          return;
        }
      }
      this.sockets.browser?.send(ev.data);
    });
    ws.addEventListener('close', () => {
      try {
        this.sockets.browser?.close(1006, 'daemon disconnected');
      } catch {
        /* browser may already be gone */
      }
      this.failAllPendingHttp(502, 'daemon disconnected');
      this.sockets.browser = undefined;
      this.sockets.daemon = undefined;
      this.browserToken = null;
    });
    ws.addEventListener('error', () => {
      try {
        this.sockets.browser?.close(1011, 'daemon error');
      } catch {
        /* browser may already be gone */
      }
    });
  }

  private wireBrowser(ws: WebSocket): void {
    ws.addEventListener('message', (ev: MessageEvent) => {
      this.sockets.daemon?.send(ev.data);
    });
    ws.addEventListener('close', () => {
      this.sockets.browser = undefined;
      this.browserToken = null;
    });
  }
}
