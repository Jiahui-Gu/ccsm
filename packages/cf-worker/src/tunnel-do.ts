import type { Env } from './index';

interface PairedSockets {
  browser?: WebSocket | undefined;
  daemon?: WebSocket | undefined;
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
 *   - Frames (text + binary) are forwarded as-is via ws.send(ev.data).
 *   - daemon close/error → browser closed with 1006/1011, both slots cleared
 *     so a fresh daemon can re-pair.
 *   - browser close → daemon stays alive; next browser can re-pair.
 *
 * S3-T2 (Task #774). e2e coverage lives in S3-T8.
 */
export class TunnelDO {
  private state: DurableObjectState;
  private env: Env;
  private sockets: PairedSockets = {};

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
      server.accept();
      this.sockets.browser = server;
      this.wireBrowser(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not Found', { status: 404 });
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
    });
  }
}
