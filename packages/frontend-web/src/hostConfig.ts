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
// Task #780 (S3-T5): default base flips to the Cloudflare tunnel URL
// (`https://cc-sm.pages.dev` / `wss://cc-sm.pages.dev`). The SPA is now
// always served from Pages; in production it talks to the daemon through
// the CF Worker + Durable Object tunnel (S3 architecture). The previous
// loopback / envBase / origin fallbacks are gone — the only escape hatch
// is the URL `?daemon=<url>` query parameter, which dev/test/Tauri shells
// use to point at a local daemon.

import type { HostConfig } from '@ccsm/ui';

export const TOKEN_STORAGE_KEY = 'ccsm.token';

/** Hard default daemon base for production (Cloudflare Pages + Worker tunnel, Task #780). */
export const DEFAULT_DAEMON_BASE = 'https://cc-sm.pages.dev';

export interface ResolveTokenDeps {
  /** Search portion of the current URL, e.g. `?token=abc`. */
  search: string;
  /** fetch implementation. */
  fetch: typeof globalThis.fetch;
  /**
   * Daemon base URL (Task #719 / S2-T4). When the SPA is served from a
   * different origin than the daemon (e.g. Cloudflare Pages → loopback
   * daemon), `/token` must be requested as an absolute URL or the browser
   * will hit the SPA host instead. Pass the result of `resolveDaemonBase()`
   * here. When omitted or empty, falls back to the relative `/token` path
   * (same-origin / daemon-embedded SPA).
   */
  daemonBase?: string;
}

/**
 * Returns the daemon bearer token, or null if neither the URL nor the
 * daemon `/token` endpoint produced one.
 *
 * Priority (Task #696, cross-origin extension Task #719):
 *   1. URL `?token=` — back-compat with legacy `ccsm ready: ...?token=` URL.
 *   2. GET <daemonBase>/token — same-origin in the daemon-embedded case;
 *      cross-origin (with CORS, see daemon http.mts) when SPA is on Pages.
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
 * Priority (Task #780 / S3-T5):
 *   1. URL `?daemon=<url>` — runtime escape hatch (dev / test / Tauri
 *      shell pointing at local loopback daemon).
 *   2. Hard default `https://cc-sm.pages.dev` — production tunnel via
 *      Cloudflare Worker + Durable Object.
 *
 * History: S2 (Task #712) preferred `window.location.origin` on loopback
 * hostnames and `VITE_DAEMON_BASE` for the Pages build. S3 collapses all
 * of that into a single default because the SPA is now always served from
 * Pages and always talks to the daemon through the tunnel unless `?daemon=`
 * explicitly redirects it.
 */
export function resolveDaemonBase(deps: ResolveDaemonBaseDeps): string {
  const fromUrl = new URLSearchParams(deps.search).get('daemon');
  if (fromUrl && fromUrl.length > 0) return normalizeBase(fromUrl);

  return DEFAULT_DAEMON_BASE;
}

/**
 * Derive the matching ws/wss base URL from an http/https base.
 *
 * Used by the SPA to pick between `wss://cc-sm.pages.dev` (production
 * tunnel) and `ws://127.0.0.1:9876` (loopback dev) without forcing the
 * caller to plumb a separate `wsBase` field. The path (`/ws/<sid>?...`)
 * is appended downstream by core's WsClient — this only sets the origin.
 */
export function resolveWsBase(deps: ResolveDaemonBaseDeps): string {
  const httpBase = resolveDaemonBase(deps);
  if (httpBase.startsWith('https://')) {
    return `wss://${httpBase.slice('https://'.length)}`;
  }
  if (httpBase.startsWith('http://')) {
    return `ws://${httpBase.slice('http://'.length)}`;
  }
  // Defensive: caller passed something exotic; hand it back unchanged.
  return httpBase;
}

function currentDaemonBase(): string {
  if (typeof window === 'undefined') return '';
  return resolveDaemonBase({
    search: window.location.search,
  });
}

export const webHostConfig: HostConfig = {
  httpBase: currentDaemonBase(),
  getToken: () => {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  },
};
