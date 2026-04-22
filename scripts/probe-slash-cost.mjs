// Probe: /cost end-to-end (renderer-only).
//
// Verifies the full /cost loop:
//   1. Stub window.agentory so we can capture the registered onAgentEvent
//      listener and trigger the pieces of the agent flow without a live
//      claude.exe.
//   2. Create a session, type a user message, send it.
//   3. Fire a fake `result` frame at the captured listener carrying realistic
//      `usage` + `total_cost_usd` numbers — agent/lifecycle.ts feeds these
//      into store.addSessionStats().
//   4. Type `/cost` + Enter and confirm the rendered status banner contains
//      both the formatted token counts and the cost.
//
// Strategy mirrors probe-slash-pr / probe-slash-exec: we run against the
// webpack dev server (no Electron / no IPC). The renderer's
// subscribeAgentEvents() runs once at module load, so by stubbing
// window.agentory.onAgentEvent inside addInitScript we observe the real
// listener that will be invoked in production.
//
// Usage:
//   AGENTORY_DEV_PORT=4192 npm run dev:web   # in another shell
//   AGENTORY_DEV_PORT=4192 node scripts/probe-slash-cost.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4192';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-cost] FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

// Install the agentory stub BEFORE app code runs so subscribeAgentEvents()
// captures *our* onAgentEvent. We expose the captured listener back on
// window.__probeAgentEmit so the probe can shoot synthetic events into it
// from the page later.
await page.addInitScript(() => {
  /** @type {Array<(e: any) => void>} */
  const listeners = [];
  /** @type {Array<{sessionId: string; text: string}>} */
  const sends = [];
  const base = {
    loadState: async (key) => {
      if (key !== 'main') return null;
      return JSON.stringify({
        version: 1,
        sessions: [],
        groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
        activeId: '',
        model: '',
        permission: 'default',
        sidebarCollapsed: false,
        theme: 'system',
        fontSize: 'md',
        recentProjects: [],
        tutorialSeen: true
      });
    },
    saveState: async () => {},
    loadMessages: async () => [],
    saveMessages: async () => {},
    getDataDir: async () => '/tmp',
    getVersion: async () => '0.0.0-probe',
    pickDirectory: async () => null,
    agentStart: async () => ({ ok: true }),
    agentSend: async (sessionId, text) => {
      sends.push({ sessionId, text });
      return true;
    },
    agentSendContent: async () => true,
    agentInterrupt: async () => true,
    agentSetPermissionMode: async () => true,
    agentSetModel: async () => true,
    agentClose: async () => true,
    agentResolvePermission: async () => true,
    onAgentEvent: (cb) => {
      listeners.push(cb);
      return () => {};
    },
    onAgentExit: () => () => {},
    onAgentPermissionRequest: () => () => {},
    scanImportable: async () => [],
    notify: async () => true,
    onNotificationFocus: () => () => {},
    updatesStatus: async () => ({ kind: 'idle' }),
    updatesCheck: async () => ({ kind: 'idle' }),
    updatesDownload: async () => ({ ok: true }),
    updatesInstall: async () => ({ ok: true }),
    updatesGetAutoCheck: async () => true,
    updatesSetAutoCheck: async () => true,
    onUpdateStatus: () => () => {},
    onUpdateDownloaded: () => () => {},
    cli: {
      retryDetect: async () => ({ found: true, path: '/fake/claude', version: '2.1.0' }),
      getInstallHints: async () => ({ os: 'win32', arch: 'x64', commands: {}, docsUrl: '' }),
      browseBinary: async () => null,
      setBinaryPath: async () => ({ ok: true, version: '2.1.0' }),
      openDocs: async () => true
    },
    window: {
      minimize: async () => {},
      toggleMaximize: async () => false,
      close: async () => {},
      isMaximized: async () => false,
      onMaximizedChanged: () => () => {},
      platform: 'win32'
    },
    connection: {
      read: async () => ({ baseUrl: null, model: null, hasAuthToken: false }),
      openSettingsFile: async () => ({ ok: true })
    },
    models: { list: async () => [] },
    openExternal: async () => true
  };
  Object.defineProperty(window, 'agentory', { value: base, writable: true, configurable: true });
  /** @type {any} */ (window).__probeAgentEmit = (e) => {
    for (const l of listeners) l(e);
  };
  /** @type {any} */ (window).__probeAgentSends = sends;
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('aside', { timeout: 15_000 });

const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

// Capture the active session id from the dev-mode store shim.
const sid = await page.evaluate(() => /** @type {any} */ (window).__agentoryStore.getState().activeId);
if (!sid) fail('no active session id after createSession');

// --- 1. Send a real user message via the InputBar so the agent flow runs.
await textarea.click();
await textarea.fill('hello cost probe');
await page.keyboard.press('Enter');
// Wait for the local-echo user block to land + InputBar to flip running=true.
await page.waitForTimeout(150);

// --- 2. Inject a synthetic `result` frame that lifecycle aggregates into
//        statsBySession. Numbers are deliberately big enough that the
//        formatTokens helper renders "12k" / "678" / "$0.023" etc.
await page.evaluate((sessionId) => {
  /** @type {any} */ (window).__probeAgentEmit({
    sessionId,
    message: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0.0234,
      usage: {
        input_tokens: 12000,
        output_tokens: 678,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 145
      }
    }
  });
}, sid);

// Give React a tick to flush the addSessionStats setState.
await page.waitForTimeout(120);

// Sanity: the store actually got the stats.
const stats = await page.evaluate(
  (sessionId) => /** @type {any} */ (window).__agentoryStore.getState().statsBySession[sessionId]
, sid);
if (!stats) fail('statsBySession entry missing after injecting result');
if (stats.outputTokens !== 678) fail(`expected outputTokens=678, got ${stats.outputTokens}`);
if (stats.inputTokens !== 12345) fail(`expected inputTokens=12345 (12000+200+145), got ${stats.inputTokens}`);
if (Math.abs(stats.costUsd - 0.0234) > 1e-9) fail(`expected costUsd=0.0234, got ${stats.costUsd}`);

// --- 3. Type `/cost` and submit. The picker opens for `/`; press Escape
//        first so Enter sends instead of selecting the highlighted row.
await textarea.click();
await textarea.fill('/cost');
await page.waitForTimeout(60);
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

const banner = page.locator('[role="status"]').filter({ hasText: 'Session cost' });
await banner.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('/cost did not render a "Session cost" status banner');
});
const text = await banner.first().innerText();
if (!/12k in/.test(text)) fail(`expected "12k in" token format in banner, got: ${text}`);
if (!/678 out/.test(text)) fail(`expected "678 out" in banner, got: ${text}`);
if (!/\$0\.023/.test(text)) fail(`expected formatted cost "$0.023" in banner, got: ${text}`);
if (!/1 turn\b/.test(text)) fail(`expected "1 turn" in banner, got: ${text}`);

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-cost] OK');
console.log('  injected result frame -> statsBySession aggregated correctly');
console.log('  /cost banner shows tokens + cost +' + ' turn count');

await browser.close();
