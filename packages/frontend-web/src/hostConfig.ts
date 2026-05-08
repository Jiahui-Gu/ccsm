// Web shell host config — daemon address resolution + sessionStorage token.
//
// Wave-2 T6 (#686): @ccsm/ui's RuntimeProvider takes a HostConfig and uses
// it to construct the SessionRuntime + bind the REST API.
//
// Task #696: token bootstrap is a 3-step priority chain (URL ?token= →
// fetch /token → fail). The pure resolver lives here so it can be
// unit-tested without booting the full SPA.
//
// Task #712 (S2-T3): daemon base URL resolution supported 3 modes so the
// SPA could be served from Cloudflare Pages (cross-origin) while still
// talking to a local loopback daemon, without breaking the existing
// daemon-embedded case (browser opens http://127.0.0.1:9876/, SPA
// same-origin).
//
// Task #780 (S3-T5): default base flipped to a hard-coded
// `https://cc-sm.pages.dev` URL so Pages-hosted SPA could reach the daemon
// through the CF Worker tunnel.
//
// Task #25 (smoke R-5): the hard-coded prod URL is wrong — the SPA should
// always reach `/token` and `/ws/default` via the SAME origin it was served
// from. The Pages Function (`[[path]].ts`) already proxies these paths into
// the Worker tunnel at the same origin, so a relative path Just Works in
// production AND in dev (Vite proxy / Pages preview) AND when the SPA is
// served from `127.0.0.1:<port>` by a smoke fixture. Default base is now
// the empty string (same-origin relative); `?daemon=<absolute>` remains the
// only escape hatch (loopback daemon / Tauri).

import type { HostConfig } from '@ccsm/ui';

export const TOKEN_STORAGE_KEY = 'ccsm.token';

/**
 * Default daemon base for production (same-origin relative).
 *
 * Task #25: empty string means "use the SPA's own origin" — `fetch('/token')`
 * and `new WebSocket('/ws/default')` resolve relative to `document.baseURI`,
 * which is the right answer whether the SPA is served from
 * `https://cc-sm.pages.dev`, a Pages preview deployment, the Vite dev
 * server, or the smoke fixture's static SPA host.
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

export const webHostConfig: HostConfig = {
  httpBase: currentDaemonBase(),
  getToken: () => {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  },
  ...(currentWsPath() !== undefined ? { wsPath: currentWsPath() as string } : {}),
};
