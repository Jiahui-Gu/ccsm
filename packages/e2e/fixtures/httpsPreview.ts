// HTTPS static preview server fixture for ccsm e2e (Task #725, S2-T9).
//
// Purpose: stand in for the production Cloudflare Pages CDN so the
// `s2-pages-loopback` spec can prove the HTTPS browser → loopback daemon
// chain end-to-end:
//
//   browser (https://localhost:<port>)
//     └── loads SPA (frontend-web/dist served via TLS)
//           └── fetches loopback daemon (http://127.0.0.1:<daemonPort>/api/...)
//                 ↑ cross-origin: triggers CORS preflight + PNA preflight
//
// Why a hand-rolled `node:https` static server instead of `vite preview --https`:
//   1. `vite preview --https` requires a TLS plugin (e.g. @vitejs/plugin-basic-ssl)
//      that is NOT in our dep tree, and adding a dep just for one e2e spec is
//      gold-plating.
//   2. We already need a static `dist/` for the test (built by `pnpm -r build`
//      in CI / `pnpm -F @ccsm/frontend-web build` locally), so vite's bundling
//      step is irrelevant here. Serving the same `dist/` via `node:https` is
//      behaviourally equivalent for the loopback chain we want to verify.
//   3. The cert is checked into `fixtures/tls/` so this fixture has zero
//      runtime dependency on system openssl. Self-signed CN=localhost,
//      SAN=DNS:localhost,IP:127.0.0.1, 10y validity (regenerate before 2036).
//
// Playwright is launched with `ignoreHTTPSErrors: true` (see spec) so the
// self-signed cert does not block navigation. The cert is e2e-only and is
// not shipped to production.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { extname, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const FRONTEND_PKG_DIR = resolve(REPO_ROOT, 'packages', 'frontend-web');
const FRONTEND_DIST = resolve(FRONTEND_PKG_DIR, 'dist');
const TLS_DIR = resolve(__dirname, 'tls');
const TLS_CERT = resolve(TLS_DIR, 'cert.pem');
const TLS_KEY = resolve(TLS_DIR, 'key.pem');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface HttpsPreviewHandle {
  /** Origin of the HTTPS preview server, e.g. `https://localhost:54321`. */
  origin: string;
  /** Port the server listens on (loopback only). */
  port: number;
  /** Stop the server. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Ensure `packages/frontend-web/dist/index.html` exists. CI runs `pnpm -r build`
 * before e2e, so dist is normally present; locally we attempt a build the first
 * time. If a build is unavailable we throw a clear error so the test fails
 * loud instead of mysteriously 404'ing.
 */
function ensureFrontendBuilt(): void {
  if (existsSync(join(FRONTEND_DIST, 'index.html'))) return;
  // Fall back to a one-shot build for the local dev case. CI should have
  // already populated dist via `pnpm -r build` (see .github/workflows/ci.yml).
  const r = spawnSync('pnpm', ['-F', '@ccsm/frontend-web', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0 || !existsSync(join(FRONTEND_DIST, 'index.html'))) {
    throw new Error(
      `frontend-web dist not built and on-demand build failed (exit=${r.status}). ` +
        `Expected ${join(FRONTEND_DIST, 'index.html')}.`,
    );
  }
}

/**
 * Resolve a request URL pathname to an absolute file path inside `FRONTEND_DIST`.
 * Returns null if the path escapes the dist root (defense-in-depth — the test
 * server should never serve outside dist) or if no matching file exists.
 *
 * SPA fallback: any request that does not map to an existing file falls back
 * to `index.html` so client-side routing keeps working (matches Cloudflare
 * Pages' default SPA behaviour).
 */
function resolveStaticPath(urlPath: string): string {
  // Strip query string + decode percent-encoding.
  const noQuery = urlPath.split('?')[0]!.split('#')[0]!;
  const decoded = decodeURIComponent(noQuery);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const abs = normalize(join(FRONTEND_DIST, rel));
  // Path-traversal guard: resolved path must stay under FRONTEND_DIST.
  if (!abs.startsWith(FRONTEND_DIST)) return join(FRONTEND_DIST, 'index.html');
  try {
    if (statSync(abs).isFile()) return abs;
  } catch {
    /* fall through to SPA fallback */
  }
  return join(FRONTEND_DIST, 'index.html');
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const filePath = resolveStaticPath(req.url ?? '/');
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('content-type', mime);
  // Disable caches so iteration on dist is observable without server bounces.
  res.setHeader('cache-control', 'no-store');
  createReadStream(filePath)
    .on('error', (err) => {
      res.statusCode = 500;
      res.end(`fixture read error: ${err.message}`);
    })
    .pipe(res);
}

/**
 * Start an HTTPS static server serving `packages/frontend-web/dist`.
 * Listens on 127.0.0.1 with an OS-assigned port (port 0). The hostname in
 * the returned origin is `localhost` because the cert SAN includes `DNS:localhost`
 * and same-origin policy requires the address bar match the cert host —
 * for ignoreHTTPSErrors that doesn't strictly matter, but keeps URLs clean.
 */
export async function startHttpsPreview(): Promise<HttpsPreviewHandle> {
  ensureFrontendBuilt();

  const cert = readFileSync(TLS_CERT);
  const key = readFileSync(TLS_KEY);

  const server: HttpsServer = createHttpsServer({ cert, key }, handleRequest);

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    server.close();
    throw new Error('https preview server: unexpected address shape');
  }
  const port = addr.port;
  const origin = `https://localhost:${port}`;

  return {
    origin,
    port,
    stop: () =>
      new Promise<void>((resolveStop) => {
        server.close(() => resolveStop());
      }),
  };
}
