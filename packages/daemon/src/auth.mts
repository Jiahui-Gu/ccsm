// Token + origin auth for /api/* routes (DESIGN.md §4, G5).
// Static GET / and /assets/* DO NOT call this — the SPA bootstraps from the
// URL token before any /api/* request is made.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Origin allow-list:
//   - http(s)://127.0.0.1 / localhost  (web SPA, dev vite proxy)
//   - tauri://localhost                 (T2 #675 — Tauri 2 webview origin)
//   - https://ccsm-worker.jiahuigu.workers.dev
//                                       (R-53 #175 — Cloudflare Workers prod host)
// The Tauri webview always sends `Origin: tauri://localhost` for in-app fetch
// and ws upgrade; we whitelist it explicitly rather than open up arbitrary
// cross-origin. See plan doc `logical-swinging-brook.md` §A / T2.
//
// R-53 #175 (was S2 #702): the production web SPA was previously served from
// `https://cc-sm.pages.dev` (Cloudflare Pages). R-53 folded the SPA + tunnel
// + OAuth callback into a single Worker on the account `workers.dev`
// subdomain — the prod host is now `https://ccsm-worker.jiahuigu.workers.dev`.
// Same security shape: cross-origin loopback fetches from the SPA into the
// local daemon (still binding 127.0.0.1) must allow the exact prod origin
// and ONLY that — no spoof variants
// (`https://ccsm-worker-evil.jiahuigu.workers.dev`,
//  `https://ccsm-worker.jiahuigu.workers.dev.attacker.com`),
// and no http (Chrome's PNA + mixed-content rules require https for the
// loopback initiator).
//
// CCSM_ALLOW_PAGES_PREVIEWS opt-in (kept name for back-compat with R-53
// migration): when `CCSM_ALLOW_PAGES_PREVIEWS=1` is set in the daemon's
// process env, single-label `*-ccsm-worker.jiahuigu.workers.dev`-shaped
// preview subdomains over https are additionally allow-listed. Cloudflare
// Workers versioned-preview URLs follow the
// `<version-id>-<worker-name>.<subdomain>.workers.dev` pattern, so we
// allowlist any single label that ends with `.<worker>.<account>.workers.dev`.
// OFF by default; mirrors the prior Pages preview opt-in.
const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);
const TAURI_ORIGIN = 'tauri://localhost';
const WORKER_PROD_ORIGIN = 'https://ccsm-worker.jiahuigu.workers.dev';
// R-53: Workers versioned preview URLs prefix the prod hostname with a
// version label, e.g. `https://abc123-ccsm-worker.jiahuigu.workers.dev`. We
// match the suffix `-ccsm-worker.jiahuigu.workers.dev` so a bare
// `ccsm-worker.jiahuigu.workers.dev` is NOT treated as a preview.
const WORKER_PREVIEW_SUFFIX = '-ccsm-worker.jiahuigu.workers.dev';
// Single DNS label: alnum, may contain internal hyphens, 1..63 chars.
// (Conservative; Cloudflare workers.dev preview labels are hashes that
// match this shape.)
const WORKER_PREVIEW_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function pagesPreviewsEnabled(): boolean {
  // Read on every call so tests can flip the flag mid-suite without
  // re-importing the module. The env access is cheap.
  return process.env.CCSM_ALLOW_PAGES_PREVIEWS === '1';
}

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
  // R-53 #175 — exact-string match for the cf-worker prod origin BEFORE
  // we hand off to URL parsing. Doing this as an exact string compare (rather
  // than parsing then checking host) makes spoof variants impossible:
  //   - `https://ccsm-worker-evil.jiahuigu.workers.dev`        → !== WORKER_PROD_ORIGIN
  //   - `https://ccsm-worker.jiahuigu.workers.dev.attacker.com`→ !== WORKER_PROD_ORIGIN
  //   - `http://ccsm-worker.jiahuigu.workers.dev`              → !== WORKER_PROD_ORIGIN
  //   - `https://abc123-ccsm-worker.jiahuigu.workers.dev` (Workers preview)
  //                                                            → !== WORKER_PROD_ORIGIN
  // All fall through to the loopback host check below and are rejected
  // (unless the preview opt-in below matches).
  if (rawOrigin === WORKER_PROD_ORIGIN) return 'allowed';
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    return 'rejected';
  }
  // R-53 (kept env name CCSM_ALLOW_PAGES_PREVIEWS for migration back-compat):
  // opt-in Cloudflare Workers versioned-preview origins of the shape
  // `https://<version>-ccsm-worker.jiahuigu.workers.dev`.
  // Checked BEFORE the loopback host gate so a preview origin doesn't get
  // spuriously rejected as "not 127.0.0.1/localhost". Must still be https,
  // exactly one version label deep, and that label must look like a real
  // DNS label.
  if (pagesPreviewsEnabled() && url.protocol === 'https:') {
    const host = url.hostname;
    if (host.endsWith(WORKER_PREVIEW_SUFFIX)) {
      const label = host.slice(0, host.length - WORKER_PREVIEW_SUFFIX.length);
      if (label.length > 0 && !label.includes('.') && WORKER_PREVIEW_LABEL_RE.test(label)) {
        return 'allowed';
      }
    }
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
