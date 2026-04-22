// Probe: /compact end-to-end (renderer-only).
//
// Verifies the pass-through path for /compact:
//   1. Stub window.agentory so we can capture both the registered
//      onAgentEvent listener AND every agentSend call.
//   2. Type `/compact` + Enter — the dispatcher returns 'pass-through' so
//      InputBar runs the normal send path, which forwards the literal text
//      to claude.exe via api.agentSend.
//   3. Confirm the captured agentSend call carries `/compact`. (This is the
//      whole point of pass-through: the SDK accepts /compact in stream-json
//      mode per https://code.claude.com/docs/en/agent-sdk/slash-commands.)
//   4. Fire a fake `system { subtype: 'compact_boundary' }` frame at the
//      captured listener — this is exactly what the SDK emits when /compact
//      finishes. Verify the existing systemBlocks() translator renders the
//      "Conversation compacted (manual) — Compacted N → M tokens" banner.
//
// Why no client-side compact handler: the SDK already owns this flow. Adding
// our own would duplicate the summarisation prompt the CLI already runs and
// drift out of sync with upstream improvements. Pass-through is the correct
// answer; this probe is the proof.
//
// Usage:
//   AGENTORY_DEV_PORT=4193 npm run dev:web   # in another shell
//   AGENTORY_DEV_PORT=4193 node scripts/probe-slash-compact.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4193';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-compact] FAIL: ${msg}`);
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

const sid = await page.evaluate(() => /** @type {any} */ (window).__agentoryStore.getState().activeId);
if (!sid) fail('no active session id after createSession');

// --- 1. Type /compact + Enter. Dismiss the picker first so Enter sends.
await textarea.click();
await textarea.fill('/compact');
await page.waitForTimeout(60);
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
await page.keyboard.press('Enter');
await page.waitForTimeout(200);

// --- 2. Confirm the literal /compact text was forwarded via agentSend.
const sends = await page.evaluate(() => /** @type {any} */ (window).__probeAgentSends);
if (!Array.isArray(sends) || sends.length === 0) fail('agentSend was never called for /compact');
const last = sends[sends.length - 1];
if (last.text !== '/compact') {
  fail(`expected agentSend text "/compact", got "${last.text}"`);
}
if (last.sessionId !== sid) {
  fail(`expected agentSend sessionId="${sid}", got "${last.sessionId}"`);
}

// --- 3. Inject the compact_boundary system frame the SDK emits when the
//        compaction completes. systemBlocks() should render a status banner.
await page.evaluate((sessionId) => {
  /** @type {any} */ (window).__probeAgentEmit({
    sessionId,
    message: {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: sessionId,
      uuid: 'probe-compact-boundary-1',
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 98700,
        post_tokens: 21450,
        duration_ms: 960
      }
    }
  });
}, sid);
await page.waitForTimeout(150);

const banner = page.locator('[role="status"]').filter({ hasText: 'Conversation compacted' });
await banner.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('compact_boundary did not render a "Conversation compacted" status banner');
});
const text = await banner.first().innerText();
if (!/manual/i.test(text)) fail(`expected "manual" trigger label in banner, got: ${text}`);
if (!/98,?700/.test(text)) fail(`expected pre_tokens 98700 in banner, got: ${text}`);
if (!/21,?450/.test(text)) fail(`expected post_tokens 21450 in banner, got: ${text}`);
if (!/960\s*ms/.test(text)) fail(`expected duration "960ms" in banner, got: ${text}`);

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-compact] OK');
console.log('  /compact forwarded literally to agentSend (pass-through verified)');
console.log('  compact_boundary frame -> "Conversation compacted (manual)" banner');

await browser.close();
