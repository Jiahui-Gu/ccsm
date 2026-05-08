export interface Env {
  TUNNEL: DurableObjectNamespace;
}

export { TunnelDO } from './tunnel-do';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isUpgrade =
      req.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    // R-15 (Task #37) — liveness probe for smoke orchestrator stage 1.
    // wrangler dev's bare `GET /` is routed into TunnelDO via the catch-all
    // below (well, used to be — now 404), and during cold-start workerd may
    // hold the connection open without flushing headers (UND_ERR_HEADERS_TIMEOUT).
    // `/health` is a static synchronous Response that touches no DO / KV /
    // binding, so it returns headers as soon as the worker module is parsed.
    // The smoke probe targets this path so a stuck DO does not masquerade as
    // a stuck listener.
    if (url.pathname === '/health') {
      return new Response('ok\n', { status: 200 });
    }

    if (
      (url.pathname === '/ws/default' || url.pathname === '/tunnel/default') &&
      isUpgrade
    ) {
      // Route both directions into the same DO instance keyed by 'default'
      // so the daemon ws and browser ws end up paired in one TunnelDO.
      // Multi-tunnel routing (per-user / per-pairing-id) is future work.
      const id = env.TUNNEL.idFromName('default');
      const stub = env.TUNNEL.get(id);
      // Task #782 (S3-T6): forward the full request (incl.
      // `Sec-WebSocket-Protocol` if the browser sent one) to the DO. The DO
      // is responsible for echoing the protocol back on the 101 response so
      // the browser doesn't reject the handshake (RFC 6455 §4.2.2 step 4).
      return stub.fetch(req);
    }

    // Task #787 (S3-C): REST `/api/*` and `/token` flow through the same DO
    // instance, which serializes them as http_req control frames over the
    // daemon-dialed ws and awaits the matching http_res. The browser only
    // ever talks to cc-sm.pages.dev; the DO bridges to the NAT'd daemon.
    if (url.pathname.startsWith('/api/') || url.pathname === '/token') {
      const id = env.TUNNEL.idFromName('default');
      const stub = env.TUNNEL.get(id);
      return stub.fetch(req);
    }

    return new Response('Not Found', { status: 404 });
  },
};
