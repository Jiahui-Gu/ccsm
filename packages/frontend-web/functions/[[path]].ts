// Task #785 [S3-B]: Cloudflare Pages Function that fronts cc-sm.pages.dev so
// the browser only ever talks to the Pages origin.
//
// Why this exists: cc-sm.pages.dev is a static SPA host. Without a Function,
// any request to `/ws/default` or `/tunnel/default` falls through to the SPA
// fallback (200 index.html), so the WebSocket upgrade handshake never reaches
// the Durable Object on ccsm-worker. This Function intercepts the tunnel
// paths and reproxies them via a service binding to the independent
// `ccsm-worker` Worker (which owns the TunnelDO Durable Object class —
// Pages Functions cannot define DO classes themselves, see Task #774 / S3-B
// research note afea153b6a17c9838 and the Pages Functions wrangler docs:
// https://developers.cloudflare.com/pages/functions/wrangler-configuration/).
//
// Scope:
//   - WebSocket paths (`/ws/default`, `/tunnel/default`) are proxied to the
//     Worker so the daemon can dial wss://cc-sm.pages.dev/tunnel/default and
//     the browser can dial wss://cc-sm.pages.dev/ws/default, both terminating
//     in the same TunnelDO instance.
//   - Task #787 (S3-C): REST `/api/*` and `/token` are also proxied to the
//     Worker, which forwards them into the same TunnelDO. The DO mux's them
//     onto the daemon-dialed ws as `http_req` control frames so the NAT'd
//     daemon can serve them. Browser only ever talks to cc-sm.pages.dev.
//   - Everything else falls through to `ctx.next()` so Pages serves the
//     static SPA assets (`/index.html`, `/assets/*`, etc.) as before.

interface Env {
  // Service binding to the standalone ccsm-worker Worker (configured in
  // wrangler.toml as `[[services]] binding = "TUNNEL_WORKER"`). Pages
  // Functions invoke it as a Fetcher; the Worker's own fetch handler routes
  // /ws/default, /tunnel/default, /api/*, and /token into the TunnelDO.
  TUNNEL_WORKER: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);

  if (
    url.pathname === '/ws/default' ||
    url.pathname === '/tunnel/default' ||
    url.pathname === '/token' ||
    url.pathname.startsWith('/api/')
  ) {
    return ctx.env.TUNNEL_WORKER.fetch(ctx.request);
  }

  // Static SPA assets and SPA fallback are handled by Pages itself.
  return ctx.next();
};
