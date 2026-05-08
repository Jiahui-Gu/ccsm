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
//   - R-14 (Task #34): SPA history-mode fallback now lives here instead of
//     in `public/_redirects`. The `_redirects` rule `/*  /index.html  200`
//     was removed because under `wrangler pages dev` it triggers a reparser
//     loop on every request (research-33 line 39-46/122-130/136), which
//     opens an ECONNRESET window during smoke. We replicate the rule by
//     rewriting non-asset, non-API GETs to `/index.html` before delegating
//     to Pages static asset serving via `ctx.next()`.

interface Env {
  // Service binding to the standalone ccsm-worker Worker (configured in
  // wrangler.toml as `[[services]] binding = "TUNNEL_WORKER"`). Pages
  // Functions invoke it as a Fetcher; the Worker's own fetch handler routes
  // /ws/default, /tunnel/default, /api/*, and /token into the TunnelDO.
  TUNNEL_WORKER: Fetcher;
}

// Heuristic: a request is for a static asset if its pathname has a file
// extension (e.g. `/assets/index-abc.js`, `/favicon.ico`). SPA history routes
// look like `/sessions/123` — no dot in the last segment.
function looksLikeStaticAsset(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);

  if (
    url.pathname === '/ws/default' ||
    url.pathname === '/tunnel/default' ||
    url.pathname === '/token' ||
    url.pathname.startsWith('/api/')
  ) {
    // R-17 log #7 (Task #45): proxy entry — pathname + upgrade hint.
    const upgrade = ctx.request.headers.get('Upgrade') ?? '';
    console.log('[pages-fn] proxy ' + url.pathname + ' upgrade=' + upgrade);
    const resp = await ctx.env.TUNNEL_WORKER.fetch(ctx.request);
    // R-17 log #7 (Task #45): proxy response — status (and upgrade resp header
    // if the worker promoted to ws so we can spot 101 vs 426/404 quickly).
    console.log('[pages-fn] proxy resp status=' + resp.status + ' upgrade=' + (resp.headers.get('Upgrade') ?? ''));
    return resp;
  }

  // R-14 — SPA history-mode fallback. If the request is a GET for a route
  // (no file extension) and not the root, rewrite to `/index.html` so Pages
  // serves the SPA shell. Static assets (anything with a dot in the last
  // segment) and non-GET methods fall through unchanged.
  if (
    ctx.request.method === 'GET' &&
    url.pathname !== '/' &&
    !looksLikeStaticAsset(url.pathname)
  ) {
    const rewritten = new Request(new URL('/index.html', url), ctx.request);
    return ctx.next(rewritten);
  }

  // Static SPA assets and the root index handled by Pages itself.
  return ctx.next();
};
