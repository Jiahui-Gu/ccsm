/**
 * S4-T5 (Task #136): JWT routing middleware for cf-worker.
 *
 * Two responsibilities:
 *
 *   1. **Auth-mode gating.** `CCSM_AUTH_MODE` env var (vars in wrangler.toml,
 *      default `legacy`) gates whether browser ws / tunnel ws / REST API
 *      requests must carry a verifiable JWT. `legacy` keeps the S3-era flow
 *      (token in `Sec-WebSocket-Protocol`, no JWT, single shared TunnelDO
 *      keyed by `'default'`). `jwt` requires the JWT; the github_id from the
 *      verified claims is used to derive a **per-user TunnelDO id**
 *      (`'user:<github_id>'`) so different GitHub users get isolated DO
 *      instances.
 *
 *   2. **JWT extraction.** Browser-side: token is in the
 *      `Sec-WebSocket-Protocol` header (subprotocol `ccsm.<jwt>`) for ws
 *      upgrades, or `Authorization: Bearer <jwt>` for REST. Daemon-side
 *      (`/tunnel/default`): always `Sec-WebSocket-Protocol: ccsm.<jwt>` since
 *      WebSockets cannot set arbitrary headers. We verify against the right
 *      key (web → `JWT_SIGNING_KEY`, tunnel → `JWT_REFRESH_SIGNING_KEY`) and
 *      narrow on `kind`.
 *
 * The TunnelDO internals (sid envelope, getBrowserSocket, hello handling)
 * are NOT touched — only the **DO id name** changes in jwt mode, plus the
 * cf-worker tags the forwarded request with the `X-CCSM-Identity-Login` /
 * `X-CCSM-Identity-Id` headers so the DO can echo them inside the hello
 * frame to the daemon (Task #133 / S4-T6 wire format).
 *
 * Production rollout: deploy with `CCSM_AUTH_MODE = "legacy"` (default in
 * wrangler.toml), then flip to `"jwt"` via `wrangler vars` once the SPA
 * sign-in UI (T7/T8) is shipped and propagates JWTs to the WebSocket /
 * Authorization layer.
 */
import type { AuthEnv } from './bindings';
import { verifyJwt, type WebJwtClaims, type TunnelJwtClaims } from './jwt';

/** Subprotocol prefix matching frontend-web/src/hostConfig.ts. */
const WS_SUBPROTOCOL_PREFIX = 'ccsm.';

export type AuthMode = 'legacy' | 'jwt';

/**
 * Read the auth mode from env. Recognized values:
 *   - `'jwt'` — enforce per-user JWT verification.
 *   - `'legacy'` / unset / undefined — S3-era token-based flow.
 *
 * Audit F-S-3 (Task #152): any other non-empty value (typo / bad config)
 * THROWS rather than silently falling back to `legacy`. Silent fallback
 * was the original behavior (Task #136) but the audit found it could mask
 * a misconfigured `wrangler vars` (e.g. `CCSM_AUTH_MODE=JWT` upper-case)
 * by quietly downgrading to legacy and skipping all JWT checks. We still
 * treat unset / empty / undefined as legacy so a fresh deploy that hasn't
 * set the var yet does not 500 — the failure mode targets typos only.
 */
export function getAuthMode(env: { CCSM_AUTH_MODE?: string }): AuthMode {
  const raw = env.CCSM_AUTH_MODE;
  if (raw === undefined || raw === '' || raw === 'legacy') return 'legacy';
  if (raw === 'jwt') return 'jwt';
  throw new Error(
    'CCSM_AUTH_MODE must be "jwt" / "legacy" / unset; got: ' + JSON.stringify(raw),
  );
}

/**
 * Per-user TunnelDO id name. R-51a (Task #167): the input is now the user
 * uuid (claims.sub) — pre-R-51 it was the github_id. This same string also
 * keys the user-blob role of UserDO (idFromName('user:<uuid>')) so a single
 * lookup namespace covers both DOs.
 */
export function getUserDoIdName(user_id: string): string {
  return 'user:' + user_id;
}

/**
 * Extract `ccsm.<jwt>` subprotocol token from Sec-WebSocket-Protocol.
 * Returns null if the header is absent / has no ccsm.* entry / token empty.
 *
 * Mirrors the `extractBrowserToken` helper in tunnel-do.ts — that one
 * returns the protocol echo string too because the DO needs it for the
 * 101 response, but middleware only cares about the bearer payload.
 */
function extractSubprotocolToken(req: Request): string | null {
  const raw = req.headers.get('sec-websocket-protocol');
  if (raw === null) return null;
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const entry of entries) {
    if (entry.startsWith(WS_SUBPROTOCOL_PREFIX)) {
      const token = entry.slice(WS_SUBPROTOCOL_PREFIX.length);
      if (token.length > 0) return token;
    }
  }
  return null;
}

/**
 * Extract `Bearer <jwt>` from Authorization header. Returns null if header
 * absent or scheme is not Bearer.
 */
function extractBearer(req: Request): string | null {
  const raw = req.headers.get('authorization');
  if (raw === null) return null;
  // Authorization: Bearer <token> — case-insensitive scheme per RFC 7235.
  const match = /^bearer\s+(\S+)\s*$/i.exec(raw);
  if (match === null) return null;
  return match[1] ?? null;
}

/**
 * Extract the `web_jwt` value from a `Cookie:` header. Returns null when
 * the header is absent or the cookie is missing/empty.
 *
 * Audit F-S-4 (Task #152): the SPA web JWT now lives in an HttpOnly cookie
 * (Path=/api) instead of URL fragment + sessionStorage so an XSS payload
 * cannot reach it. REST `/api/*` requests carry the cookie automatically;
 * `/ws/default` cannot (browsers don't send cookies on WebSocket subprotocol
 * upgrades from cross-origin SPA + browsers strip them on subprotocol-only
 * channels) so the SPA fetches a short-lived ws-ticket JWT first and passes
 * it as the `Sec-WebSocket-Protocol` value (see `handleWsTicket`).
 */
export const WEB_JWT_COOKIE = 'web_jwt';

function extractWebJwtCookie(req: Request): string | null {
  const raw = req.headers.get('cookie');
  if (raw === null) return null;
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k !== WEB_JWT_COOKIE) continue;
    const v = pair.slice(eq + 1).trim();
    return v.length > 0 ? v : null;
  }
  return null;
}

/**
 * Verify a browser-presented web JWT.
 *
 * Source priority (audit F-S-4, Task #152):
 *   1. HttpOnly `web_jwt` cookie — REST `/api/*` requests in cookie-based
 *      flow. The SPA never reads or sets this; only the cf-worker does.
 *   2. WS subprotocol `ccsm.<jwt>` — `/ws/default` upgrades carry a
 *      short-lived ws-ticket JWT here (cookies don't ride WebSocket
 *      subprotocol channels).
 *   3. Authorization Bearer — Tauri shell / smoke / loopback backstop where
 *      the daemon-minted token path is still in play.
 *
 * Returns null on:
 *   - no token present in any source
 *   - signature invalid / expired (verifyJwt returns null)
 *   - `kind` is not `'web'` (daemon-class token presented at browser path)
 */
export async function extractWebJwt(
  req: Request,
  env: AuthEnv,
): Promise<WebJwtClaims | null> {
  const token =
    extractWebJwtCookie(req) ??
    extractSubprotocolToken(req) ??
    extractBearer(req);
  if (token === null) return null;
  const claims = await verifyJwt<WebJwtClaims>(token, env.JWT_SIGNING_KEY);
  if (claims === null) return null;
  if (claims.kind !== 'web') return null;
  return claims;
}

/**
 * Verify a daemon-presented tunnel JWT. Daemons only ever present this via
 * the WS subprotocol (no Authorization header path). Verifies against the
 * refresh signing key (per S4 D5 — tunnel JWTs are minted with the refresh
 * key so a leaked web key cannot mint daemon-class tokens).
 */
export async function extractTunnelJwt(
  req: Request,
  env: AuthEnv,
): Promise<TunnelJwtClaims | null> {
  const token = extractSubprotocolToken(req);
  if (token === null) return null;
  const claims = await verifyJwt<TunnelJwtClaims>(
    token,
    env.JWT_REFRESH_SIGNING_KEY,
  );
  if (claims === null) return null;
  if (claims.kind !== 'tunnel') return null;
  return claims;
}
