export interface Env {
  TUNNEL: DurableObjectNamespace;
  // S4-T3 (Task #140): the auth subsystem (web OAuth + UserDO) needs these.
  // Augmented shape is `AuthEnv` in `./auth/bindings`; we keep the names
  // here so the worker fetch handler can pass `env` into `dispatchAuth`
  // without an explicit cast. They are populated by wrangler secret in prod
  // and by `.dev.vars` locally — see `.dev.vars.example`.
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  JWT_SIGNING_KEY: string;
  JWT_REFRESH_SIGNING_KEY: string;
  USER_DO: DurableObjectNamespace;
  /**
   * S4-T5 (Task #136): auth mode toggle. `legacy` keeps the S3-era token-
   * based flow with a single shared TunnelDO keyed by `'default'`. `jwt`
   * enforces JWT verification on /ws/*, /tunnel/*, /api/*, /token and
   * routes each user into a per-user TunnelDO id (`user:<github_id>`).
   * Default `legacy` so unset / misconfigured deploys never lock users out.
   */
  CCSM_AUTH_MODE?: string;
  /**
   * Task #154 (R-49 audit P1, F-A-2): Workers Static Assets binding for the
   * folded `cc-sm` SPA. Configured in wrangler.toml as
   * `[assets] directory = "../frontend-web/dist" binding = "ASSETS"`.
   * Used as a belt-and-suspenders fallback when a request reaches the
   * Worker's catch-all branch (e.g. an unknown `/foo` path matched by a
   * future broader `run_worker_first` glob): we defer to the asset server
   * which honors `not_found_handling = "single-page-application"` and
   * returns the SPA shell for unknown routes.
   */
  ASSETS: Fetcher;
}

export { TunnelDO } from './tunnel-do';
// S4-T2 (Task #121): UserDO is bound in wrangler.toml so it must be re-exported
// from the worker entrypoint for the runtime to resolve the class.
export { UserDO } from './auth/userDO';

import { dispatchAuth } from './auth/webOauth';
import { dispatchDevice } from './auth/deviceFlow';
import {
  extractTunnelJwt,
  extractWebJwt,
  getAuthMode,
  getUserDoIdName,
} from './auth/middleware';
import type { AuthEnv } from './auth/bindings';

/**
 * S4-T5 (Task #136): clone the incoming request with cf-worker-injected
 * identity headers so the TunnelDO can echo them into the daemon hello
 * frame (Task #133 wire format). Browser ws path only — the daemon path
 * does not need identity injection (the tunnel JWT itself carries login +
 * github_id and the daemon already trusts the cloud-issued token).
 */
function withIdentityHeaders(
  req: Request,
  login: string,
  github_id: string,
): Request {
  const headers = new Headers(req.headers);
  headers.set('X-CCSM-Identity-Login', login);
  headers.set('X-CCSM-Identity-Id', github_id);
  return new Request(req, { headers });
}

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

    // S4-T3 (Task #140): browser OAuth + refresh + logout. These run in the
    // Worker itself (NOT muxed through TunnelDO) because they talk to GitHub
    // directly and read/write UserDO. Routing them before the TunnelDO
    // /api/* branch ensures /api/auth/* never reaches the daemon path.
    if (url.pathname.startsWith('/api/auth/')) {
      // S4-T4 (Task #142): device flow + tunnel refresh land here first.
      const devRes = await dispatchDevice(req, env);
      if (devRes !== null) return devRes;
      const authRes = await dispatchAuth(req, env);
      if (authRes !== null) return authRes;
      // Path under /api/auth/ but not ours (e.g. wrong method) → 404.
      return new Response('Not Found', { status: 404 });
    }

    // S4-T5 (Task #136): mode toggle. In `legacy` (default, current
    // production) the routing below behaves exactly as before: single shared
    // DO keyed by `'default'`, no JWT check. In `jwt` we extract + verify
    // the per-user JWT, derive the per-user DO id, and inject identity
    // headers (browser path) before forwarding into the DO.
    const mode = getAuthMode(env);
    const authEnv = env as AuthEnv;

    if (url.pathname === '/ws/default' && isUpgrade) {
      if (mode === 'jwt') {
        const claims = await extractWebJwt(req, authEnv);
        if (claims === null) {
          // Browsers cannot read 401 bodies on a ws handshake reliably; the
          // expected UX is a close frame after upgrade. We can't open the
          // socket from the worker layer (TunnelDO does), so refuse the
          // upgrade with 401 here. The SPA's WebSocket onclose handler
          // will surface this as auth failure to the user.
          return new Response('unauthorized', { status: 401 });
        }
        const id = env.TUNNEL.idFromName(getUserDoIdName(claims.sub));
        const stub = env.TUNNEL.get(id);
        console.log('[worker] route /ws/default upgrade=true mode=jwt user=' + claims.login);
        return stub.fetch(withIdentityHeaders(req, claims.login, claims.sub));
      }
      // legacy: single shared DO, no JWT check.
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

    if (url.pathname === '/tunnel/default' && isUpgrade) {
      if (mode === 'jwt') {
        const claims = await extractTunnelJwt(req, authEnv);
        if (claims === null) {
          return new Response('unauthorized', { status: 401 });
        }
        const id = env.TUNNEL.idFromName(getUserDoIdName(claims.sub));
        const stub = env.TUNNEL.get(id);
        console.log('[worker] route /tunnel/default upgrade=true mode=jwt user=' + claims.login + ' jti=' + claims.jti);
        // Daemon side does not need X-CCSM-Identity-* headers — the daemon
        // is the trusted side; identity is injected only on the browser
        // path (so the DO can echo it into the daemon-bound hello frame).
        return stub.fetch(req);
      }
      const id = env.TUNNEL.idFromName('default');
      const stub = env.TUNNEL.get(id);
      console.log('[worker] route ' + url.pathname + ' upgrade=' + isUpgrade);
      return stub.fetch(req);
    }

    // Task #787 (S3-C): REST `/api/*` and `/token` flow through the same DO
    // instance, which serializes them as http_req control frames over the
    // daemon-dialed ws and awaits the matching http_res. The browser only
    // ever talks to cc-sm.pages.dev; the DO bridges to the NAT'd daemon.
    if (url.pathname.startsWith('/api/') || url.pathname === '/token') {
      let doIdName = 'default';
      if (mode === 'jwt') {
        const claims = await extractWebJwt(req, authEnv);
        if (claims === null) {
          return new Response('unauthorized', { status: 401 });
        }
        doIdName = getUserDoIdName(claims.sub);
      }
      const id = env.TUNNEL.idFromName(doIdName);
      const stub = env.TUNNEL.get(id);
      // R-17 log #12 (Task #45): record HTTP-mux route entry into the DO stub.
      console.log('[worker] route ' + url.pathname + ' upgrade=' + isUpgrade + ' mode=' + mode);
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

    // Task #154 (R-49 audit P1, F-A-2): catch-all defers to the Workers
    // Static Assets binding instead of returning a hard 404. With
    // `not_found_handling = "single-page-application"` (wrangler.toml), the
    // asset server returns 200 + index.html for unknown routes so SPA
    // history-mode deep links resolve to the shell. Real static assets
    // (`/assets/*`, `/favicon.ico`, etc.) bypass the Worker entirely on the
    // asset-first fast path because they are not listed in
    // `run_worker_first`; this branch only runs for paths that *did* invoke
    // the Worker but didn't match any known dynamic handler above (e.g. a
    // future broader `run_worker_first` glob, or a `/api/*` request that
    // fell through the auth dispatch).
    return env.ASSETS.fetch(req);
  },
};
