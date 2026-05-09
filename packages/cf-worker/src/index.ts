export interface Env {
  TUNNEL: DurableObjectNamespace;
}

export { TunnelDO } from './tunnel-do';
// S4-T2 (Task #121): UserDO is bound in wrangler.toml so it must be re-exported
// from the worker entrypoint for the runtime to resolve the class. Routes that
// dispatch into UserDO are introduced in T5 — this is a binding-only export.
export { UserDO } from './auth/userDO';

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
      // R-17 log #12 (Task #45): record ws-route entry into the DO stub.
      console.log('[worker] route ' + url.pathname + ' upgrade=' + isUpgrade);
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
      // R-17 log #12 (Task #45): record HTTP-mux route entry into the DO stub.
      console.log('[worker] route ' + url.pathname + ' upgrade=' + isUpgrade);
      // R-28 (Task #85): /token 502 取证 — log each /token request entry +
      // upstream response status, including method + the cf-ray + the
      // request id from cf headers so we can correlate with the DO log.
      const r28Method = req.method;
      const r28Cf = req.headers.get('cf-ray') ?? '-';
      const r28Ua = (req.headers.get('user-agent') ?? '-').slice(0, 32);
      console.log('[r28][worker] enter path=' + url.pathname + ' method=' + r28Method + ' cf-ray=' + r28Cf + ' ua=' + r28Ua);
      const r28Started = Date.now();
      const r28Res = await stub.fetch(req);
      console.log('[r28][worker] exit path=' + url.pathname + ' status=' + r28Res.status + ' dur_ms=' + (Date.now() - r28Started) + ' cf-ray=' + r28Cf);
      return r28Res;
    }

    return new Response('Not Found', { status: 404 });
  },
};
