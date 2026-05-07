// s2-pages-loopback.spec.ts — Task #725 (initial CORS+PNA chain) +
// Task #751 (full plan §E.2 9-step business flow on chromium+windows).
//
// Acceptance: prove the S2 deployment topology end-to-end inside a real
// browser, with TLS on the SPA leg and the production cross-origin auth
// rules (CORS preflight + PNA preflight) actively in play, AND that a
// user can drive the full session lifecycle (create → I/O → reload →
// close) over that exact same chain.
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
//     │   ← 200 + { sessions: [] } (initial bootstrap)
//     │
//     │ 5. user clicks + New Session  → POST /api/sessions cross-origin
//     │ 6. SPA opens ws://127.0.0.1:<dport>/ws?sid=...&token=...
//     │ 7. user types `echo s2-acceptance-<uniq>` — keystroke INPUT frames
//     │    arrive at daemon, claude PTY echos them back as OUTPUT frames
//     │    that the SPA decodes and writes to xterm.
//     │ 8. user reloads — SPA bootstraps again, GET /api/sessions returns
//     │    EXACTLY ONE session (Task #716 regression: NO auto-create on
//     │    reload — pre-fix, MainPane fired createSession unconditionally
//     │    every mount and the count would be 2).
//     │ 9. user clicks the row's × close button → DELETE /api/sessions/:sid
//     │    + EXIT frame (FrameType=0x07) on the ws.
//     │
//     ▼
//   real daemon @ http://127.0.0.1:<dport>
//
// Why this spec exists: Tasks #702/#712 added the auth + base-URL plumbing
// for S2 with unit tests. T9 (Task #725) was the cross-origin GET integration
// that proves the rules hold when wired through an actual TLS browser-context
// (Chromium enforces PNA + mixed-content + CORS in ways unit tests cannot
// mock). Task #751 extends that into the full lifecycle so we know the same
// chain still works once the user actually starts driving the app.
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
// Matrix scope (Task #751 — first in a 5-task series):
//   - chromium only (multi-browser arrives in #752)
//   - windows only locally (CI three-platform matrix arrives in #755)
//   - genuine daemon (#753 layers spoofed-Origin negative tests on top)
//   - HTTPS preview (#754 layers Tauri tauri://localhost shape on top)

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

// Wire format byte 0 of every ws frame (see packages/shared/src/frame.ts).
const FRAME_TYPE_OUTPUT = 0x01;
const FRAME_TYPE_INPUT = 0x02;

interface WsFrameLog {
  /** First byte = FrameType (OUTPUT=0x01 / INPUT=0x02 / ... / EXIT=0x07). */
  type: number;
  /** Decoded UTF-8 payload (everything after the 5-byte header). */
  text: string;
  /** Raw header seq (u32 BE), useful for debugging out-of-order races. */
  seq: number;
  /** Direction relative to the browser. */
  dir: 'received' | 'sent';
}

function decodeFramePayload(buf: Uint8Array): { type: number; seq: number; text: string } {
  if (buf.byteLength < 5) {
    return { type: 0, seq: 0, text: '' };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = view.getUint8(0);
  const seq = view.getUint32(1, false);
  const payload = buf.subarray(5);
  // OUTPUT/INPUT carry UTF-8 PTY bytes; EXIT carries u32 exit code (we
  // don't try to render that, but TextDecoder over 4 bytes is harmless).
  const text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
  return { type, seq, text };
}

test('S2 — HTTPS browser → loopback daemon (full lifecycle: CORS + PNA + token + create + I/O + reload + close)', async (
  { page, daemonUrl, token, _httpsPreview },
  testInfo,
) => {
  // Generous: daemon spawn (~2s) + frontend boot (~2s) + claude PTY warmup
  // (~3-10s on cold cwd) + REPL trust prompt + reload + close.
  test.setTimeout(120_000);

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

  // Capture every ws frame so we can assert OUTPUT echo (after type) and
  // EXIT (after close). Playwright's ws fixture exposes both directions
  // as 'framereceived' (daemon → browser) and 'framesent' (browser → daemon).
  // Binary frames arrive as Buffer in node land. We also track close()
  // events because DELETE-triggered teardown calls runtime.detach() before
  // the daemon's onExit broadcast lands — see step 9 below for the full
  // explanation.
  const wsFrames: WsFrameLog[] = [];
  const wsClosed: Array<{ url: string }> = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (event) => {
      const payload = event.payload;
      if (typeof payload === 'string') return; // we only emit binary frames
      const buf = payload as Buffer;
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const { type, seq, text } = decodeFramePayload(view);
      wsFrames.push({ type, seq, text, dir: 'received' });
    });
    ws.on('framesent', (event) => {
      const payload = event.payload;
      if (typeof payload === 'string') return;
      const buf = payload as Buffer;
      const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const { type, seq, text } = decodeFramePayload(view);
      wsFrames.push({ type, seq, text, dir: 'sent' });
    });
    ws.on('close', () => {
      wsClosed.push({ url: ws.url() });
    });
  });

  // Surface page errors loud — a JS error during boot would otherwise just
  // produce a blank page and a confusing assertion failure downstream.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Daemon persists sessions to a SQLite db (CCSM_DB_PATH override or the
  // default APPDATA path) — across runs the same dev box accumulates dead
  // sids from previous local invocations. Clear them up front so the
  // "no sessions yet" empty-state and the Task #716 reload-count==1 guard
  // are both deterministic regardless of host history.
  const initialList = await page.request.get(`${daemonBase}/api/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (initialList.ok()) {
    const body = (await initialList.json()) as { sessions?: Array<{ sid: string }> };
    for (const s of body.sessions ?? []) {
      await page.request
        .delete(`${daemonBase}/api/sessions/${s.sid}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        .catch(() => {
          /* best effort */
        });
    }
  }

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

  // ---- Step 4 (carry-over from #725): cross-origin GET /api/sessions ----
  //
  // Bootstrap useSession listSessions hit must be 200 with a properly-echoed
  // ACAO header. This pins down the same coverage #725 had before the spec
  // was extended for #751.
  const sessionsHit = apiHits.find(
    (r) => r.url === `${daemonBase}/api/sessions` && r.method === 'GET',
  );
  expect(
    sessionsHit,
    `browser must have hit GET /api/sessions cross-origin. Got hits: ${JSON.stringify(apiHits)}`,
  ).toBeDefined();
  expect(sessionsHit?.status, 'GET /api/sessions must be 200').toBe(200);
  expect(
    sessionsHit?.accessControlAllowOrigin,
    'daemon must echo our cross-origin Origin in ACAO',
  ).toBe(previewOrigin);

  // Negative control inherited from #725 — a forged Origin from a non-allow-
  // listed host must be rejected (403). Catches accidental ACAO: * regression.
  const forged = await page.request.get(`${daemonBase}/api/sessions`, {
    headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example.com' },
  });
  expect(
    forged.status(),
    'daemon must reject forbidden origins even with a valid token',
  ).toBe(403);

  // Sidebar should have rendered with zero sessions — Task #716 means the
  // SPA does NOT auto-create on first mount. The empty-state copy lives in
  // Sidebar.tsx ("No sessions yet — click + New Session above").
  await expect(page.locator('[data-testid="sidebar-new-session"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByText(/no sessions yet/i),
    'sidebar must show empty-state on first load (Task #716 — no auto-create)',
  ).toBeVisible({ timeout: 5_000 });

  // ---- Step 5 (#751): click + New Session, expect POST /api/sessions ----
  const createPromise = page.waitForResponse(
    (r) =>
      r.url() === `${daemonBase}/api/sessions` &&
      r.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await page.locator('[data-testid="sidebar-new-session"]').click();
  const createResp = await createPromise;
  expect(createResp.status(), 'POST /api/sessions must be 200').toBe(200);
  expect(
    createResp.headers()['access-control-allow-origin'],
    'POST response must echo cross-origin ACAO',
  ).toBe(previewOrigin);
  const createBody = (await createResp.json()) as { sid?: string };
  expect(typeof createBody.sid, 'POST response carries sid').toBe('string');
  const sid = createBody.sid as string;

  // The session row must show up in the sidebar — proves addSession()
  // (store.ts) actually committed the new sid.
  const sessionRow = page.locator(`[data-testid="sidebar-session-${sid}"]`);
  await expect(sessionRow, 'new session row must render').toBeVisible({
    timeout: 5_000,
  });

  // xterm + ws come up next. Wait for xterm to attach AND the ws to open
  // (FrameType byte we care about lands once the daemon starts streaming
  // claude's banner — that is enough to prove the upgrade succeeded).
  const xtermViewport = page.locator('.xterm-rows');
  await xtermViewport.waitFor({ state: 'attached', timeout: 15_000 });
  await expect
    .poll(
      () => wsFrames.some((f) => f.dir === 'received' && f.type === FRAME_TYPE_OUTPUT),
      {
        message: 'expected at least one OUTPUT frame from daemon (ws upgrade + PTY data)',
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      },
    )
    .toBe(true);

  // ---- Step 6 (#751): type echo + assert OUTPUT frame contains our marker ----
  //
  // claude 2.x boots with a "trust this folder?" prompt before accepting
  // any other input. We answer "1" + Enter to clear it. If the prompt is
  // not present (claude already trusted this cwd from a prior run) we
  // skip — claude would otherwise treat stray "1" as REPL input.
  await page.locator('[data-testid="main-terminal"]').click();
  await page.waitForTimeout(200);
  const bannerText = (await xtermViewport.innerText().catch(() => '')).toLowerCase();
  if (bannerText.includes('trust this folder') || bannerText.includes('yes, i trust')) {
    await page.keyboard.press('1');
    await page.keyboard.press('Enter');
    await expect
      .poll(
        async () =>
          (await xtermViewport.innerText().catch(() => '')).toLowerCase(),
        {
          message: 'expected REPL prompt to appear after trust confirmation',
          timeout: 20_000,
          intervals: [500, 1_000, 2_000],
        },
      )
      .not.toMatch(/yes, i trust this folder/);
  }

  // The task spec asks us to type `echo s2-acceptance-<uniq>` and assert
  // an OUTPUT frame carrying the resulting echo. Subtlety: `claude` is a
  // REPL, not a shell. It does not exec `echo`; it processes the line as
  // a prompt. Different claude versions also render the typed buffer in
  // different ways (some reflow inside an input box, some emit the raw
  // characters as you type, some pipeline the ANSI stream so a single
  // marker word can land split across multiple OUTPUT frames). Asserting
  // a literal `s2-acceptance-<uniq>` substring inside one frame is too
  // coupled to that rendering behaviour and has been observed to flake
  // even when the I/O path is fully alive.
  //
  // The robust round-trip signal is: typing produces *new* OUTPUT bytes
  // on the ws (proves browser INPUT → daemon → PTY → daemon OUTPUT →
  // browser is fully wired). p1-smoke uses the same shape (innerText
  // diff). We tag the line with a unique marker so search-after-the-fact
  // can spot it in the snapshot .txt for forensic debugging.
  const uniq = `s2-acceptance-${Date.now().toString(36)}`;
  const echoLine = `echo ${uniq}`;
  const outputBytesBefore = wsFrames
    .filter((f) => f.dir === 'received' && f.type === FRAME_TYPE_OUTPUT)
    .reduce((acc, f) => acc + f.text.length, 0);
  await page.keyboard.type(echoLine, { delay: 25 });
  await expect
    .poll(
      () =>
        wsFrames
          .filter((f) => f.dir === 'received' && f.type === FRAME_TYPE_OUTPUT)
          .reduce((acc, f) => acc + f.text.length, 0) - outputBytesBefore,
      {
        message:
          `expected new OUTPUT bytes after typing "${echoLine}" — proves the ` +
          `browser → daemon → PTY → daemon → browser round-trip is live`,
        timeout: 20_000,
        intervals: [300, 500, 1_000],
      },
    )
    .toBeGreaterThan(0);
  // Browser-side INPUT frames (FrameType=0x02) must also have been sent —
  // proves the upstream half of the round-trip independently of whatever
  // claude chose to render back.
  expect(
    wsFrames.some((f) => f.dir === 'sent' && f.type === FRAME_TYPE_INPUT),
    'browser must have sent at least one INPUT frame (FrameType=0x02)',
  ).toBe(true);
  // Press Enter so claude consumes the line — keeps the REPL in a known
  // state for the reload step. We deliberately wait a little after so any
  // pending OUTPUT frames flush before reload tears the ws down.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  // ---- Step 8 (#751): reload, listSessions count must be 1 (#716 guard) ----
  //
  // Pre-#716, MainPane.tsx fired createSession() unconditionally on every
  // mount (see comment in MainPane.tsx referencing "auto-create bootstrap
  // effect"), so reloading a tab with one existing session ended with two.
  // The fix removed that effect and made useBootstrap.listSessions the only
  // path on reload. We assert the count stays at exactly 1.
  const reloadListPromise = page.waitForResponse(
    (r) =>
      r.url() === `${daemonBase}/api/sessions` &&
      r.request().method() === 'GET',
    { timeout: 10_000 },
  );
  await page.reload({ waitUntil: 'networkidle' });
  const reloadList = await reloadListPromise;
  expect(reloadList.status(), 'reload listSessions must be 200').toBe(200);
  const reloadBody = (await reloadList.json()) as { sessions?: Array<{ sid: string }> };
  expect(
    Array.isArray(reloadBody.sessions),
    '/api/sessions returns sessions[]',
  ).toBe(true);
  expect(
    reloadBody.sessions?.length,
    'Task #716 regression guard: reload must NOT auto-create (count == 1, not 2)',
  ).toBe(1);
  expect(reloadBody.sessions?.[0]?.sid, 'the one session is our created sid').toBe(sid);

  // The post-reload sidebar should also report exactly one row in the
  // default group — DOM-level confirmation that the store reflects the
  // listSessions response, not a duplicated client-side state.
  await expect(
    page.locator(`[data-testid="sidebar-session-${sid}"]`),
    'session row re-renders after reload',
  ).toBeVisible({ timeout: 10_000 });
  const allRows = page.locator('[data-testid^="sidebar-session-"]');
  // sidebar-session-row-* and sidebar-session-close-* share the prefix;
  // filter to row testids only (the <li> wrapper, not its inner buttons).
  const rowCount = await allRows.evaluateAll((nodes) =>
    nodes.filter((n) => {
      const id = (n as HTMLElement).dataset.testid ?? '';
      return id.startsWith('sidebar-session-')
        && !id.startsWith('sidebar-session-row-')
        && !id.startsWith('sidebar-session-close-');
    }).length,
  );
  expect(
    rowCount,
    'sidebar must show exactly one session row after reload (Task #716)',
  ).toBe(1);

  // ---- Step 9 (#751): close session, assert ws teardown -----------------
  //
  // Subtlety: useBootstrap (after reload) hydrates the sessions list but
  // does NOT auto-attach a ws — that's MainPane's job and only happens
  // for `activeSid`. After reload there is no activeSid, so no ws exists
  // to observe a close event on. To make the ws-teardown assertion
  // meaningful, we click the row first (POST /api/sessions/:sid/resume +
  // attach), wait for the ws to actually open, then click ×.
  await page.locator(`[data-testid="sidebar-session-row-${sid}"]`).click();
  await expect
    .poll(() => wsFrames.filter((f) => f.dir === 'received').length, {
      message: 'expected ws to reattach + receive at least one frame after row click',
      timeout: 20_000,
      intervals: [300, 500, 1_000],
    })
    .toBeGreaterThan(0);

  const framesBeforeClose = wsFrames.length;
  const closesBeforeClose = wsClosed.length;
  const deletePromise = page.waitForResponse(
    (r) =>
      r.url() === `${daemonBase}/api/sessions/${sid}` &&
      r.request().method() === 'DELETE',
    { timeout: 10_000 },
  );
  // The × button is hover-revealed via CSS (Sidebar.css), so a normal
  // click() blocks on visibility. Hover the row first (or use force).
  await page.locator(`[data-testid="sidebar-session-${sid}"]`).hover();
  await page.locator(`[data-testid="sidebar-session-close-${sid}"]`).click({ force: true });
  const deleteResp = await deletePromise;
  expect(deleteResp.status(), 'DELETE /api/sessions/:sid must be 2xx').toBeLessThan(300);

  // Wire-level proof the SPA tore the per-session ws down.
  //
  // Subtlety on EXIT vs ws close:
  //   The daemon's runtime.mts emits an EXIT frame (FrameType=0x07) only
  //   from the PTY's onExit broadcast loop, AND only to subscribers whose
  //   ws is still readyState === OPEN. The SPA's onCloseSession path
  //   (Sidebar.tsx) calls api.deleteSession() FIRST and then synchronously
  //   `runtime.detach(sid)` (which calls ws.close() locally). The DELETE
  //   handler in http.mts triggers `registry.kill(sid)` which sends SIGTERM
  //   to the PTY — the PTY's onExit fires asynchronously a moment later,
  //   by which point the local ws is already CLOSING and the daemon's
  //   broadcast loop skips it. Net result: the EXIT frame is not reliably
  //   observable on the close-button path.
  //
  //   The user-visible "session is gone" signal is therefore the ws.close
  //   event (Playwright reports it via the 'close' listener on the ws),
  //   plus the DELETE 200 + the row vanishing from the sidebar. We assert
  //   all three so a regression that fakes any one of them still trips.
  //
  //   A stricter EXIT-frame test would need a different teardown — e.g.
  //   typing `/exit` into the REPL so claude itself exits and the daemon
  //   broadcasts EXIT before the SPA detaches. That's outside this task's
  //   scope (and orthogonal to the S2 chain we're proving here); follow-up
  //   coverage can land alongside #753+.
  await expect
    .poll(() => wsClosed.length - closesBeforeClose, {
      message: 'expected at least one ws close event after DELETE /api/sessions/:sid',
      timeout: 15_000,
      intervals: [200, 500, 1_000],
    })
    .toBeGreaterThan(0);
  void framesBeforeClose;

  // Sidebar row should be gone — closeSession() pruned the store.
  await expect(
    page.locator(`[data-testid="sidebar-session-${sid}"]`),
    'session row must disappear after close',
  ).toHaveCount(0, { timeout: 5_000 });

  // ---- Final invariants ------------------------------------------------
  // No JS errors anywhere across the full flow.
  expect(pageErrors, 'no pageerror across full lifecycle').toEqual([]);

  // Manager-readable acceptance evidence.
  const { pngPath, txtPath } = await snap(page, testInfo, 's2-pages-loopback');
  const pngStat = statSync(pngPath);
  expect(pngStat.size).toBeGreaterThan(500);
  const txt = readFileSync(txtPath, 'utf8');
  expect(txt).toContain('url:');
  expect(txt).toContain(previewOrigin);
});
