// s2-pages-loopback.spec.ts — Task #725 (S2-T9).
//
// Acceptance: prove the S2 deployment topology end-to-end inside a real
// browser, with TLS on the SPA leg and the production cross-origin auth
// rules (CORS preflight + PNA preflight) actively in play.
//
//   browser (https://localhost:<previewPort>)              ← TLS, like Pages
//     │
//     │ 1. GET /                       → SPA index.html (served by httpsPreview)
//     │ 2. GET /assets/*.js            → SPA bundle
//     │
//     │ SPA bootstraps:
//     │   - URL has ?token=<t>&daemon=http://127.0.0.1:<dport>
//     │   - resolveToken() picks the URL token (Task #696)
//     │   - resolveDaemonBase() picks the URL daemon override (Task #712)
//     │
//     │ 3. CORS+PNA preflight: OPTIONS /api/sessions             ← cross-origin
//     │      Origin: https://localhost:<previewPort>             (allowed by
//     │      Access-Control-Request-Private-Network: true        auth.mts)
//     │   ← 204 + Access-Control-Allow-Origin / Allow-Private-Network: true
//     │
//     │ 4. GET /api/sessions             ← actual cross-origin loopback hit
//     │      Origin: https://localhost:<previewPort>
//     │      Authorization: Bearer <token>
//     │   ← 200 + { sessions: [...] }
//     │
//     ▼
//   real daemon @ http://127.0.0.1:<dport>
//
// Why this spec exists: Tasks #702/#712 added the auth + base-URL plumbing
// for S2 with unit tests. T9 is the integration that proves the rules hold
// when wired through an actual TLS browser-context (Chromium enforces PNA
// + mixed-content + CORS in ways unit tests cannot mock).
//
// Stand-in for Cloudflare Pages: a hand-rolled `node:https` static server
// (fixtures/httpsPreview.ts). The task spec calls this out as
// "vite preview --https" — see the fixture header for why we serve the
// same `dist/` over node:https instead of pulling in
// @vitejs/plugin-basic-ssl just for one e2e.
//
// Self-signed cert (fixtures/tls/cert.pem) → Playwright launched with
// ignoreHTTPSErrors: true.
//
// CI note: this spec runs on the standard e2e matrix (ubuntu+windows). It
// does NOT need authed claude (no PTY spawn — the HTTP API surface is
// enough to prove the loopback chain), so unlike p1-smoke / p3-stress it
// is NOT in the --grep-invert exclusion list in ci.yml.

import { expect } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';

import { test as daemonTest } from '../fixtures/daemon.ts';
import { startHttpsPreview, type HttpsPreviewHandle } from '../fixtures/httpsPreview.ts';
import { snap } from '../fixtures/screenshot.ts';

// Compose the daemon fixture (worker-scoped) with a worker-scoped HTTPS
// preview server. Both teardown automatically at worker shutdown.
const test = daemonTest.extend<object, { _httpsPreview: HttpsPreviewHandle }>({
  _httpsPreview: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture API.
    async ({}, use) => {
      const handle = await startHttpsPreview();
      try {
        await use(handle);
      } finally {
        await handle.stop();
      }
    },
    { scope: 'worker' },
  ],
});

// ignoreHTTPSErrors lives at context level — required because the preview
// server uses a self-signed cert checked into fixtures/tls/.
test.use({ ignoreHTTPSErrors: true });

test('S2 — HTTPS browser → loopback daemon (CORS + PNA + token chain)', async (
  { page, daemonUrl, token, _httpsPreview },
  testInfo,
) => {
  test.setTimeout(45_000);

  // daemonUrl is `http://127.0.0.1:<port>/?token=<t>` — strip query/path to
  // get the bare base the SPA fetch layer expects.
  const daemonBase = new URL(daemonUrl).origin;
  const previewOrigin = _httpsPreview.origin;

  // Capture every loopback API hit (request + response) so we can assert
  // both the cross-origin chain (preflight + actual) and the response
  // shape after the SPA finishes bootstrapping.
  interface ApiHit {
    url: string;
    status: number;
    method: string;
    accessControlAllowOrigin: string | null;
  }
  const apiHits: ApiHit[] = [];
  page.on('response', (resp) => {
    const u = resp.url();
    if (!u.startsWith(daemonBase)) return;
    apiHits.push({
      url: u,
      status: resp.status(),
      method: resp.request().method(),
      accessControlAllowOrigin: resp.headers()['access-control-allow-origin'] ?? null,
    });
  });

  // Surface page errors loud — a JS error during boot would otherwise just
  // produce a blank page and a confusing assertion failure downstream.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Pre-seed sessionStorage with the token BEFORE the SPA bundle evaluates.
  // Background: `packages/ui/src/store.ts` reads the token via
  // `sessionStorage.getItem('ccsm.token')` at module-evaluation time, so a
  // pristine browser context that *only* gets a `?token=` query string sees
  // a null store token (main.tsx writes sessionStorage AFTER the static
  // import chain has already evaluated the store). This pre-seed mirrors
  // what a real user's second-visit / bookmarked Pages tab looks like:
  // the token is already cached from the previous visit, so listSessions
  // fires on first mount.
  //
  // We pin the origin to `previewOrigin` so sessionStorage lands on the
  // right (HTTPS) origin rather than about:blank's empty origin. Note we
  // load `/` first (not the full URL) so the SPA bundle does not boot with
  // a missing token and render the "daemon offline" fallback.
  await page.goto(`${previewOrigin}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ tokenValue }) => {
      sessionStorage.setItem('ccsm.token', tokenValue);
    },
    { tokenValue: token },
  );

  const url =
    `${previewOrigin}/?token=${encodeURIComponent(token)}` +
    `&daemon=${encodeURIComponent(daemonBase)}`;
  await page.goto(url, { waitUntil: 'networkidle' });

  // 1. Cross-origin GET /api/sessions must have landed and returned 200.
  const sessionsHit = apiHits.find(
    (r) => r.url === `${daemonBase}/api/sessions` && r.method === 'GET',
  );
  expect(
    sessionsHit,
    `browser must have hit GET /api/sessions cross-origin. Got hits: ${JSON.stringify(apiHits)}`,
  ).toBeDefined();
  expect(sessionsHit?.status, 'GET /api/sessions must be 200').toBe(200);

  // 2. The 200 response must carry an Access-Control-Allow-Origin header
  //    matching our HTTPS preview origin — proves the daemon's CORS layer
  //    (auth.mts classifyOrigin + http.mts CORS headers) accepted us as a
  //    cross-origin caller. If this header were missing or wildcard, real
  //    Pages users would see a CORS console error.
  expect(
    sessionsHit?.accessControlAllowOrigin,
    'daemon must echo our cross-origin Origin in ACAO',
  ).toBe(previewOrigin);

  // 3. Body shape sanity: `{ sessions: [] }` even with zero sessions.
  //    page.request goes through the same cross-origin path as the SPA, so
  //    re-issuing GET /api/sessions here exercises the chain a second time
  //    AND lets us inspect the parsed JSON without racing the SPA.
  const apiResp = await page.request.get(`${daemonBase}/api/sessions`, {
    headers: { authorization: `Bearer ${token}`, origin: previewOrigin },
  });
  expect(apiResp.status()).toBe(200);
  const body = (await apiResp.json()) as { sessions?: unknown };
  expect(Array.isArray(body.sessions), '/api/sessions returns sessions[]').toBe(true);

  // 4. Negative control — a forged Origin header from a non-allow-listed
  //    host must be rejected (403). Catches accidental ACAO: * regression.
  const forged = await page.request.get(`${daemonBase}/api/sessions`, {
    headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example.com' },
  });
  expect(
    forged.status(),
    'daemon must reject forbidden origins even with a valid token',
  ).toBe(403);

  // 5. No JS errors during the boot path.
  expect(pageErrors, 'no pageerror during SPA boot').toEqual([]);

  // Manager-readable acceptance evidence.
  const { pngPath, txtPath } = await snap(page, testInfo, 's2-pages-loopback');
  const pngStat = statSync(pngPath);
  expect(pngStat.size).toBeGreaterThan(500);
  const txt = readFileSync(txtPath, 'utf8');
  expect(txt).toContain('url:');
  expect(txt).toContain(previewOrigin);
});
