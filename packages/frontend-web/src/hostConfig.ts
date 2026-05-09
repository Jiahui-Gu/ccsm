// Web shell host config — daemon address resolution + sessionStorage token.
//
// Wave-2 T6 (#686): @ccsm/ui's RuntimeProvider takes a HostConfig and uses
// it to construct the SessionRuntime + bind the REST API.
//
// Audit F-S-4 (Task #152): the SPA no longer stores the long-lived web JWT
// in sessionStorage. The cf-worker callback puts it in an HttpOnly
// `web_jwt` cookie scoped to /api; REST `/api/*` requests pick it up
// automatically (cookie). The WebSocket subprotocol channel cannot ride
// cookies, so the SPA fetches a 60-second `ws_ticket` JWT via
// `POST /api/auth/ws-ticket` and presents it as `ccsm.<ticket>`. This
// module exposes:
//   - `primeWsTicket(fetch)` — call at sign-in / before connecting ws.
//   - `getCachedWsTicket()` — used by the (synchronous) HostConfig.getToken.
// Smoke / Tauri loopback paths keep writing the daemon-minted token to
// `sessionStorage[TOKEN_STORAGE_KEY]`; getToken falls back to it when no
// ws-ticket has been primed (no OAuth in those flows).

import type { HostConfig } from '@ccsm/ui';

export const TOKEN_STORAGE_KEY = 'ccsm.token';

/**
 * Default daemon base for production (same-origin relative).
 *
 * Task #25: empty string means "use the SPA's own origin" — `fetch('/token')`
 * and `new WebSocket('/ws/default')` resolve relative to `document.baseURI`.
 */
export const DEFAULT_DAEMON_BASE = '';

export interface ResolveTokenDeps {
  /** Search portion of the current URL, e.g. `?token=abc`. */
  search: string;
  /** fetch implementation. */
  fetch: typeof globalThis.fetch;
  /**
   * Daemon base URL (Task #719 / S2-T4). When the SPA is served from a
   * different origin than the daemon (e.g. Tauri shell → loopback daemon),
   * `/token` must be requested as an absolute URL or the browser will hit
   * the SPA host instead. Pass the result of `resolveDaemonBase()` here.
   * When omitted or empty, falls back to the relative `/token` path
   * (same-origin, the default for cloud + dev).
   */
  daemonBase?: string;
}

/**
 * Returns the daemon bearer token, or null if neither the URL nor the
 * daemon `/token` endpoint produced one.
 *
 * Priority (Task #696, cross-origin extension Task #719):
 *   1. URL `?token=` — back-compat with legacy `ccsm ready: ...?token=` URL.
 *   2. GET <daemonBase>/token — same-origin in the cloud + dev case (the
 *      Pages Function proxies into the CF Worker tunnel); cross-origin
 *      (with CORS, see daemon http.mts) when a Tauri/loopback daemon shell
 *      sets `?daemon=`.
 *   3. null — caller surfaces a friendly "daemon offline / no token" UI.
 *
 * The function is pure w.r.t. its `deps` argument (no window / sessionStorage
 * access) so the priority chain can be tested with stub deps.
 */
export async function resolveToken(deps: ResolveTokenDeps): Promise<string | null> {
  const fromUrl = new URLSearchParams(deps.search).get('token');
  if (fromUrl && fromUrl.length > 0) return fromUrl;

  const base = deps.daemonBase && deps.daemonBase.length > 0 ? deps.daemonBase : '';
  const tokenUrl = `${base}/token`;
  try {
    const res = await deps.fetch(tokenUrl);
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token === 'string' && body.token.length > 0) {
      return body.token;
    }
    return null;
  } catch {
    // Daemon offline / network error / non-JSON body — caller decides.
    return null;
  }
}

export interface ResolveDaemonBaseDeps {
  /** Search portion of the current URL, e.g. `?daemon=http://127.0.0.1:8888`. */
  search: string;
}

function normalizeBase(raw: string): string {
  // Drop trailing slash so callers can append `/api/...` without doubling up.
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Resolve the HTTP base URL the SPA should use to talk to the daemon.
 *
 * Priority (Task #25 / smoke R-5):
 *   1. URL `?daemon=<url>` — runtime escape hatch (Tauri shell / loopback
 *      daemon / smoke probe pointing at a foreign daemon).
 *   2. Empty string — same-origin relative. The SPA's host (Pages, Vite
 *      dev, smoke fixture) proxies `/token`, `/api/...`, and `/ws/default`
 *      into the daemon (CF Worker tunnel in cloud, Vite proxy in dev).
 *
 * History: S2 (Task #712) preferred `window.location.origin` on loopback
 * hostnames; S3 (Task #780) replaced everything with a hard-coded
 * `https://cc-sm.pages.dev`. Task #25 went back to same-origin because the
 * hard-coded URL broke smoke (SPA at `127.0.0.1:8788` cannot fetch a Pages
 * URL — `ERR_FAILED` / CORS) AND was redundant in cloud (Pages serves the
 * SPA AND proxies the tunnel from the same origin).
 */
export function resolveDaemonBase(deps: ResolveDaemonBaseDeps): string {
  const fromUrl = new URLSearchParams(deps.search).get('daemon');
  if (fromUrl && fromUrl.length > 0) return normalizeBase(fromUrl);

  return DEFAULT_DAEMON_BASE;
}

/**
 * Derive the matching ws/wss base URL from an http/https base.
 *
 * Used by the SPA to pick between an explicit `?daemon=` host and the
 * default same-origin ws/wss. With the Task #25 default (empty `httpBase`),
 * we synthesize the ws origin from `window.location` so callers that need
 * an absolute URL (e.g. WsClient) get `wss://<spa-host>` / `ws://<spa-host>`.
 * The path (`/ws/default`) is appended downstream.
 */
export function resolveWsBase(deps: ResolveDaemonBaseDeps): string {
  const httpBase = resolveDaemonBase(deps);
  if (httpBase.startsWith('https://')) {
    return `wss://${httpBase.slice('https://'.length)}`;
  }
  if (httpBase.startsWith('http://')) {
    return `ws://${httpBase.slice('http://'.length)}`;
  }
  // Empty / same-origin: derive from window.location when available.
  if (typeof window !== 'undefined' && window.location) {
    const { protocol, host } = window.location;
    const wsScheme = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${host}`;
  }
  // SSR / no window — hand back as-is; caller falls back to relative URL.
  return httpBase;
}

function currentDaemonBase(): string {
  if (typeof window === 'undefined') return '';
  return resolveDaemonBase({
    search: window.location.search,
  });
}

/**
 * Decide which ws path the SPA should hit (Task #793, S3-G).
 *
 * - Cloud / Pages default (no `?daemon=` override): `/ws/default`. The
 *   Pages Function + Worker only route literal `/ws/default` into the
 *   TunnelDO; anything else falls through to the SPA index.html.
 * - `?daemon=` override: leave undefined so core's WsClient falls back to
 *   `API_PATHS.ws` (`/ws`), which is what the loopback daemon serves.
 */
export function resolveWsPath(deps: ResolveDaemonBaseDeps): string | undefined {
  const fromUrl = new URLSearchParams(deps.search).get('daemon');
  if (fromUrl && fromUrl.length > 0) return undefined;
  return '/ws/default';
}

function currentWsPath(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return resolveWsPath({ search: window.location.search });
}

/**
 * WebSocket subprotocol prefix (Task #782, S3-T6).
 *
 * Browsers do not allow custom headers on `new WebSocket(url)`, so we smuggle
 * the daemon bearer token over the only browser-pickable header: the
 * `Sec-WebSocket-Protocol` request header (RFC 6455 §1.9). The CF Worker
 * extracts the token from this header, the DO forwards it to the daemon as
 * the first frame (`{type:"hello",token}`), and the daemon runs it through
 * the SAME `classifyOrigin` / token check path used by the loopback HTTP /
 * ws auth (no new auth path).
 */
export const WS_SUBPROTOCOL_PREFIX = 'ccsm.';

export interface GetWsProtocolDeps {
  /** Token reader (sessionStorage in the browser; injectable for tests). */
  getToken: () => string | null;
}

/**
 * Returns the subprotocol array to pass to `new WebSocket(url, protocols)`.
 *
 * Encoding: `['ccsm.<token>']`. We do not URL-encode — the token charset is
 * a daemon-minted UUID-shape (alnum + dashes), which is already a valid
 * RFC 6455 subprotocol token (RFC 7230 `tchar`). If the token is missing or
 * empty, returns `[]` (no subprotocol). Caller (ws client) is responsible
 * for failing fast in that case — the worker rejects unauth'd ws upgrades.
 */
export function getWsProtocol(deps: GetWsProtocolDeps): string[] {
  const token = deps.getToken();
  if (token === null || token.length === 0) return [];
  return [`${WS_SUBPROTOCOL_PREFIX}${token}`];
}

/**
 * Token reader used by the SessionRuntime / WsClient (audit F-S-4, Task #152).
 *
 * Priority:
 *   1. In-memory ws-ticket cache — populated by `primeWsTicket()` at
 *      sign-in. The HttpOnly `web_jwt` cookie is server-side; the SPA
 *      receives only this short-lived (60s) ticket as a token-shaped value.
 *   2. sessionStorage `ccsm.token` — legacy daemon-minted token (smoke /
 *      Tauri loopback). Skipped when a fresh ws-ticket exists.
 *   3. null — caller falls back to "signed out" UI (SignInScreen).
 *
 * Exposed as a standalone function so component tests can inject without
 * stubbing `webHostConfig` itself.
 */
export function readSessionToken(): string | null {
  const cached = getCachedWsTicket();
  if (cached !== null) return cached;
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

// ---- ws-ticket cache (audit F-S-4) -------------------------------------

interface WsTicketCacheEntry {
  ticket: string;
  /** epoch ms when this ticket expires; renew before this. */
  expiresAtMs: number;
}

let wsTicketCache: WsTicketCacheEntry | null = null;
/**
 * Renew the ticket when within this many ms of expiry. ws-ticket TTL is
 * 60s server-side; renewing at <= 10s ensures we never present an expired
 * one and gives plenty of margin for a slow connect.
 */
const WS_TICKET_RENEW_MARGIN_MS = 10_000;

function isCachedWsTicketFresh(now: number): boolean {
  return (
    wsTicketCache !== null &&
    wsTicketCache.expiresAtMs - now > WS_TICKET_RENEW_MARGIN_MS
  );
}

/** Read-only view of the cache. Used by readSessionToken (sync). */
export function getCachedWsTicket(): string | null {
  if (wsTicketCache === null) return null;
  if (!isCachedWsTicketFresh(Date.now())) return null;
  return wsTicketCache.ticket;
}

/** Test seam — clear the in-memory cache. */
export function _resetWsTicketCacheForTests(): void {
  wsTicketCache = null;
}

/**
 * Fetch a fresh ws-ticket from `POST /api/auth/ws-ticket`. Caches it in
 * module state; subsequent calls within the freshness window return the
 * cached value without a round-trip. Throws on network / 401 so callers
 * can surface a re-auth prompt.
 *
 * Used by AuthContext on sign-in (so `getCachedWsTicket()` is hot before
 * the first ws connect) and by ws connect retry paths.
 */
export async function primeWsTicket(
  fetchImpl: typeof globalThis.fetch = typeof window !== 'undefined'
    ? window.fetch.bind(window)
    : (() => {
        throw new Error('fetch unavailable');
      }) as typeof globalThis.fetch,
): Promise<string | null> {
  if (isCachedWsTicketFresh(Date.now())) {
    return wsTicketCache!.ticket;
  }
  try {
    const res = await fetchImpl('/api/auth/ws-ticket', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      wsTicketCache = null;
      return null;
    }
    const body = (await res.json()) as { ws_ticket?: unknown; expires_in?: unknown };
    if (typeof body.ws_ticket !== 'string' || body.ws_ticket.length === 0) {
      wsTicketCache = null;
      return null;
    }
    const ttlSec =
      typeof body.expires_in === 'number' && body.expires_in > 0
        ? body.expires_in
        : 60;
    wsTicketCache = {
      ticket: body.ws_ticket,
      expiresAtMs: Date.now() + ttlSec * 1000,
    };
    return body.ws_ticket;
  } catch {
    wsTicketCache = null;
    return null;
  }
}

export const webHostConfig: HostConfig = {
  httpBase: currentDaemonBase(),
  getToken: readSessionToken,
  ...(currentWsPath() !== undefined ? { wsPath: currentWsPath() as string } : {}),
};
