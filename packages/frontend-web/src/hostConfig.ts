// Web shell host config — daemon address resolution + sessionStorage token.
//
// Wave-2 T6 (#686): @ccsm/ui's RuntimeProvider takes a HostConfig and uses
// it to construct the SessionRuntime + bind the REST API.
//
// Task #696: token bootstrap is a 3-step priority chain (URL ?token= →
// fetch /token → fail). The pure resolver lives here so it can be
// unit-tested without booting the full SPA.
//
// Task #712 (S2-T3): daemon base URL resolution supports 3 modes so the SPA
// can be served from Cloudflare Pages (cross-origin) while still talking to
// a local loopback daemon, without breaking the existing daemon-embedded
// case (browser opens http://127.0.0.1:9876/, SPA same-origin).
//
//   1. URL `?daemon=` override — runtime escape hatch (e.g. user wants to
//      point a Pages-hosted SPA at a non-default port).
//   2. Build-time `VITE_DAEMON_BASE` — Pages build injects the canonical
//      loopback URL.
//   3. Fallback — if hostname is loopback (127.0.0.1 / localhost / ::1),
//      use `window.location.origin` (preserves the daemon-embedded default,
//      same-origin requests, no CORS); otherwise use VITE_DAEMON_BASE or
//      the hard default `http://127.0.0.1:9876`.

import type { HostConfig } from '@ccsm/ui';

export const TOKEN_STORAGE_KEY = 'ccsm.token';

/** Hard default daemon base, used when env var is missing in cross-origin mode. */
export const DEFAULT_DAEMON_BASE = 'http://127.0.0.1:9876';

export interface ResolveTokenDeps {
  /** Search portion of the current URL, e.g. `?token=abc`. */
  search: string;
  /** fetch implementation. Must accept a relative URL. */
  fetch: typeof globalThis.fetch;
}

/**
 * Returns the daemon bearer token, or null if neither the URL nor the
 * daemon `/token` endpoint produced one.
 *
 * Priority (Task #696):
 *   1. URL `?token=` — back-compat with legacy `ccsm ready: ...?token=` URL.
 *   2. GET /token (same-origin) — preferred path so users can just open
 *      `http://127.0.0.1:9876/` with no query string.
 *   3. null — caller surfaces a friendly "daemon offline / no token" UI.
 *
 * The function is pure w.r.t. its `deps` argument (no window / sessionStorage
 * access) so the priority chain can be tested with stub deps.
 */
export async function resolveToken(deps: ResolveTokenDeps): Promise<string | null> {
  const fromUrl = new URLSearchParams(deps.search).get('token');
  if (fromUrl && fromUrl.length > 0) return fromUrl;

  try {
    const res = await deps.fetch('/token');
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
  /** Current page hostname, e.g. `127.0.0.1`, `localhost`, `cc-sm.pages.dev`. */
  hostname: string;
  /** Current page origin, used as same-origin fallback for the daemon-embedded case. */
  origin: string;
  /** Build-time injected default. Pass `import.meta.env.VITE_DAEMON_BASE` from the runtime. */
  envBase: string | undefined;
}

/** Loopback hostnames that mean "the SPA is served by a local daemon". */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizeBase(raw: string): string {
  // Drop trailing slash so callers can append `/api/...` without doubling up.
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Resolve the HTTP base URL the SPA should use to talk to the daemon.
 *
 * Priority (Task #712):
 *   1. URL `?daemon=<url>` — runtime override (debugging / non-default port).
 *   2. Loopback hostname (127.0.0.1 / localhost) → `origin`. This preserves
 *      the daemon-embedded default: same-origin, no CORS, no env needed.
 *   3. `VITE_DAEMON_BASE` — build-time injected (e.g. for Pages).
 *   4. Hard default `http://127.0.0.1:9876`.
 *
 * Order rationale: rule 2 sits above rule 3 so that running a daemon-served
 * SPA on a custom port (`http://127.0.0.1:18080/`) keeps working even when
 * a stale `VITE_DAEMON_BASE` was baked into the bundle.
 */
export function resolveDaemonBase(deps: ResolveDaemonBaseDeps): string {
  const fromUrl = new URLSearchParams(deps.search).get('daemon');
  if (fromUrl && fromUrl.length > 0) return normalizeBase(fromUrl);

  if (LOOPBACK_HOSTNAMES.has(deps.hostname)) {
    return normalizeBase(deps.origin);
  }

  if (deps.envBase && deps.envBase.length > 0) {
    return normalizeBase(deps.envBase);
  }

  return DEFAULT_DAEMON_BASE;
}

function currentDaemonBase(): string {
  if (typeof window === 'undefined') return '';
  return resolveDaemonBase({
    search: window.location.search,
    hostname: window.location.hostname,
    origin: window.location.origin,
    envBase: import.meta.env.VITE_DAEMON_BASE,
  });
}

export const webHostConfig: HostConfig = {
  httpBase: currentDaemonBase(),
  getToken: () => {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  },
};
