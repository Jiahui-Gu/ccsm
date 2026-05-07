// Web shell host config — same-origin daemon address + sessionStorage token.
//
// Wave-2 T6 (#686): @ccsm/ui's RuntimeProvider takes a HostConfig and uses
// it to construct the SessionRuntime + bind the REST API. The web shell
// always talks to the same origin (the daemon serves the bundle), so
// httpBase comes from window.location and the token comes from
// sessionStorage (main.tsx wrote it there during bootstrap).
//
// Task #696: token bootstrap is a 3-step priority chain (URL ?token= →
// fetch /token → fail). The pure resolver lives here so it can be
// unit-tested without booting the full SPA.

import type { HostConfig } from '@ccsm/ui';

export const TOKEN_STORAGE_KEY = 'ccsm.token';

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

export const webHostConfig: HostConfig = {
  httpBase: typeof window !== 'undefined' ? window.location.origin : '',
  getToken: () => {
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  },
};
