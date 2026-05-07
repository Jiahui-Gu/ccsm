// Token + origin auth for /api/* routes (DESIGN.md §4, G5).
// Static GET / and /assets/* DO NOT call this — the SPA bootstraps from the
// URL token before any /api/* request is made.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Origin allow-list:
//   - http(s)://127.0.0.1 / localhost  (web SPA, dev vite proxy)
//   - tauri://localhost                 (T2 #675 — Tauri 2 webview origin)
//   - https://cc-sm.pages.dev           (S2 #702 — Cloudflare Pages prod host)
// The Tauri webview always sends `Origin: tauri://localhost` for in-app fetch
// and ws upgrade; we whitelist it explicitly rather than open up arbitrary
// cross-origin. See plan doc `logical-swinging-brook.md` §A / T2.
//
// S2 #702: the production web SPA is served from `https://cc-sm.pages.dev`
// (Cloudflare Pages). It issues cross-origin loopback fetches to the local
// daemon (which still binds 127.0.0.1) so we must allow the exact origin
// `https://cc-sm.pages.dev` and ONLY that — no PR-preview subdomains
// (`https://abc123.cc-sm.pages.dev` is reject-by-default; T8 #?? will gate
// preview origins behind an explicit opt-in flag), no spoof variants
// (`https://cc-sm-evil.pages.dev`, `https://cc-sm.pages.dev.attacker.com`),
// and no http (Chrome's PNA + mixed-content rules require https for the
// loopback initiator).
const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);
const TAURI_ORIGIN = 'tauri://localhost';
const PAGES_PROD_ORIGIN = 'https://cc-sm.pages.dev';

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function constantTimeEquals(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; pad to avoid leaking length.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a compare on a same-length buffer to keep timing similar.
    const filler = Buffer.alloc(aBuf.length, 0);
    timingSafeEqual(aBuf, filler);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Single source of truth for "is this Origin allowed".
 *
 * Returns:
 *   - 'absent'   : header not sent (treat as same-origin per #672 — see
 *                  requireAuth doc). Caller decides whether to allow.
 *   - 'allowed'  : header is in the loopback allow-list or `tauri://localhost`.
 *   - 'rejected' : anything else (e.g. https://evil.com, file://, malformed).
 *
 * Exported so ws.mts can apply identical policy at upgrade time.
 */
export function classifyOrigin(rawOrigin: string | undefined): 'absent' | 'allowed' | 'rejected' {
  if (rawOrigin === undefined || rawOrigin.length === 0) return 'absent';
  if (rawOrigin === TAURI_ORIGIN) return 'allowed';
  // S2 #702 — exact-string match for the Cloudflare Pages prod origin BEFORE
  // we hand off to URL parsing. Doing this as an exact string compare (rather
  // than parsing then checking host) makes spoof variants impossible:
  //   - `https://cc-sm-evil.pages.dev`              → !== PAGES_PROD_ORIGIN
  //   - `https://cc-sm.pages.dev.attacker.com`      → !== PAGES_PROD_ORIGIN
  //   - `http://cc-sm.pages.dev`                    → !== PAGES_PROD_ORIGIN
  //   - `https://abc123.cc-sm.pages.dev` (PR preview) → !== PAGES_PROD_ORIGIN
  // All fall through to the loopback host check below and are rejected.
  if (rawOrigin === PAGES_PROD_ORIGIN) return 'allowed';
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    return 'rejected';
  }
  if (!ALLOWED_ORIGIN_PROTOCOLS.has(url.protocol)) return 'rejected';
  if (!ALLOWED_ORIGIN_HOSTS.has(url.hostname)) return 'rejected';
  return 'allowed';
}

function extractBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Validates token + origin for /api/* requests. On rejection writes a JSON
 * error response and returns false; caller should not write further.
 *
 * Origin policy (#672):
 *   - Per the Fetch spec, browsers OMIT the `Origin` header on same-origin
 *     simple GET/HEAD requests (Origin is only attached for CORS-relevant
 *     requests). Because the SPA + API are served same-origin (daemon serves
 *     dist in prod; vite proxies /api/* to the daemon in dev so the browser
 *     still sees same-origin), the `GET /api/sessions` request that
 *     `useBootstrap` issues arrives with NO Origin header. Treat that as
 *     same-origin and allow it through (token is still verified below).
 *   - When an Origin IS present, it must be in the allow-list (loopback
 *     http/https, or `tauri://localhost` for the Tauri 2 desktop shell —
 *     T2 #675). A cross-origin attacker (evil.com) still gets 403.
 */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
): boolean {
  const rawOrigin = req.headers.origin;
  const origin = typeof rawOrigin === 'string' && rawOrigin.length > 0 ? rawOrigin : undefined;
  const decision = classifyOrigin(origin);
  // 'absent' = same-origin per #672, allow through (token still verified below).
  if (decision === 'rejected') {
    console.warn(
      `[ccsm] auth: rejected origin=${JSON.stringify(rawOrigin ?? null)} url=${req.url}`,
    );
    writeJson(res, 403, { error: 'forbidden_origin' });
    return false;
  }

  const presented = extractBearer(req.headers.authorization);
  if (!presented || !constantTimeEquals(presented, expectedToken)) {
    console.warn(
      `[ccsm] auth: rejected token (presented=${presented ? 'yes' : 'no'}) url=${req.url}`,
    );
    writeJson(res, 401, { error: 'unauthorized' });
    return false;
  }

  return true;
}
