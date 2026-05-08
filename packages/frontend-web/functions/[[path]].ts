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
// Scope (intentionally narrow for this task):
//   - WebSocket paths (`/ws/default`, `/tunnel/default`) are proxied to the
//     Worker so the daemon can dial wss://cc-sm.pages.dev/tunnel/default and
//     the browser can dial wss://cc-sm.pages.dev/ws/default, both terminating
//     in the same TunnelDO instance.
//   - REST `/api/*` is NOT proxied here yet. The daemon sits behind NAT and
//     the Worker cannot dial back into it, so REST has to flow over the same
//     ws tunnel (HTTP-over-tunnel framing). That is a separate followup task.
//     For now REST stays on the loopback `?daemon=` escape hatch used in dev.
//   - Everything else falls through to `ctx.next()` so Pages serves the
//     static SPA assets (`/index.html`, `/assets/*`, etc.) as before.

interface Env {
  // Service binding to the standalone ccsm-worker Worker (configured in
  // wrangler.toml as `[[services]] binding = "TUNNEL_WORKER"`). Pages
  // Functions invoke it as a Fetcher; the Worker's own fetch handler routes
  // /ws/default and /tunnel/default into the TunnelDO.
  TUNNEL_WORKER: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);

  if (url.pathname === '/ws/default' || url.pathname === '/tunnel/default') {
    return ctx.env.TUNNEL_WORKER.fetch(ctx.request);
  }

  // Static SPA assets and SPA fallback are handled by Pages itself.
  return ctx.next();
};
