import type { Env } from './index';

interface PairedSockets {
  browser?: WebSocket | undefined;
  daemon?: WebSocket | undefined;
}

/** Subprotocol prefix matching frontend-web/src/hostConfig.ts (Task #782). */
const WS_SUBPROTOCOL_PREFIX = 'ccsm.';

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

function buildHelloFrame(token: string): string {
  const frame: HelloFrame = { type: 'hello', token };
  return JSON.stringify(frame);
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
 *
 * Lifecycle:
 *   - On browser pair: DO extracts token from Sec-WebSocket-Protocol header,
 *     stores it on `browserToken`, echoes the same protocol on the 101
 *     response (RFC 6455 §4.2.2 — browser rejects the handshake otherwise),
 *     and emits a hello control frame `{type:"hello",token}` to the daemon
 *     before any browser->daemon raw forwarding (Task #782, S3-T6).
 *   - Frames (text + binary) after hello are forwarded as-is via ws.send.
 *   - daemon close/error → browser closed with 1006/1011, both slots cleared
 *     so a fresh daemon can re-pair.
 *   - browser close → daemon stays alive; next browser can re-pair. Token
 *     state is reset so a fresh browser gets re-authed.
 *
 * S3-T2 (Task #774). Token plumbing S3-T6 (Task #782). e2e in S3-T8.
 */
export class TunnelDO {
  private state: DurableObjectState;
  private env: Env;
  private sockets: PairedSockets = {};
  private browserToken: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    void this.state;
    void this.env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const upgrade = req.headers.get('Upgrade');
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

  private wireDaemon(ws: WebSocket): void {
    ws.addEventListener('message', (ev: MessageEvent) => {
      this.sockets.browser?.send(ev.data);
    });
    ws.addEventListener('close', () => {
      try {
        this.sockets.browser?.close(1006, 'daemon disconnected');
      } catch {
        /* browser may already be gone */
      }
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
