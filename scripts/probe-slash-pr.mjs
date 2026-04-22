// Probe: /pr slash command end-to-end (renderer-only).
//
// Strategy: we don't need a real git repo or gh binary — the IPC surface is
// the only thing separating the renderer from those. We stub window.agentory.pr
// inside the page before the user types, then drive the UI via keyboard/DOM:
//
//   1. Type /pr + Enter → PrDialog appears with seeded title / body / base.
//   2. Click "Open PR" → dialog closes, a pr-status block appears in chat,
//      the block carries the URL returned by the stub, CI checks render from
//      the stub's /checks response.
//
// Runs against the webpack dev server on AGENTORY_DEV_PORT (default 4100).
// See rules: this repo's user prefers 4194 for AI-driven dev, so we surface
// that in the help.
//
// Usage:
//   AGENTORY_DEV_PORT=4194 npm run dev:web   # in another shell
//   AGENTORY_DEV_PORT=4194 node scripts/probe-slash-pr.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4100';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-pr] FAIL: ${msg}`);
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

// Install the PR-flow stub + IPC shim BEFORE the app code runs, so the
// orchestrator sees `window.agentory.pr` on first render.
await page.addInitScript(() => {
  const pr = {
    preflight: async () => ({
      ok: true,
      branch: 'feat/probe-demo',
      base: 'main',
      availableBases: ['main', 'working'],
      repoRoot: '/fake/repo',
      suggestedTitle: 'feat: probe demo',
      suggestedBody: '## Summary\n\n- feat: probe demo\n\n---\nGenerated with agentory-next.'
    }),
    create: async () => ({
      ok: true,
      url: 'https://github.com/acme/widgets/pull/99',
      number: 99
    }),
    checks: async () => ({
      ok: true,
      checks: [
        { name: 'test', status: 'completed', conclusion: 'success', detailsUrl: 'https://ci/test' },
        { name: 'lint', status: 'completed', conclusion: 'success' }
      ]
    })
  };
  const base = {
    loadState: async (key) => {
      // Pre-mark tutorialSeen so the empty-state CTAs render immediately
      // instead of the multi-step onboarding overlay (which doesn't have
      // a visible "New Session" button on its first step).
      if (key === 'main') {
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
      }
      return null;
    },
    saveState: async () => {},
    loadMessages: async () => [],
    saveMessages: async () => {},
    getDataDir: async () => '/tmp',
    getVersion: async () => '0.0.0-probe',
    pickDirectory: async () => null,
    agentStart: async () => ({ ok: true }),
    agentSend: async () => true,
    agentSendContent: async () => true,
    agentInterrupt: async () => true,
    agentSetPermissionMode: async () => true,
    agentSetModel: async () => true,
    agentClose: async () => true,
    agentResolvePermission: async () => true,
    onAgentEvent: () => () => {},
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
      retryDetect: async () => ({ found: true, path: '/fake/claude', version: '1.0.0' }),
      getInstallHints: async () => ({ os: 'win32', arch: 'x64', commands: {}, docsUrl: '' }),
      browseBinary: async () => null,
      setBinaryPath: async () => ({ ok: true, version: '1.0.0' }),
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
    models: {
      list: async () => []
    },
    pr,
    openExternal: async () => true
  };
  Object.defineProperty(window, 'agentory', { value: base, writable: true, configurable: true });
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Create a session so the input bar + chat surface mount.
const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 15_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });
await textarea.click();

// --- 1. Type /pr and hit Enter → dialog opens --------------------------
await page.keyboard.type('/pr');
await page.waitForTimeout(80);
await page.keyboard.press('Enter');

const dialog = page.locator('[data-testid="pr-dialog"]');
await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
  fail('PrDialog did not open after /pr + Enter');
});

// Seeded title from preflight stub. The seed runs in a useEffect after
// dialog mounts, so we wait for a non-empty value rather than reading
// the input synchronously.
const titleInput = page.locator('[data-testid="pr-title"]');
await page
  .waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="pr-title"]');
      return el && (el).value && (el).value.length > 0;
    },
    null,
    { timeout: 3000 }
  )
  .catch(() => {});
const seeded = await titleInput.inputValue();
if (seeded !== 'feat: probe demo') {
  fail(`expected seeded title "feat: probe demo", got "${seeded}"`);
}

// Base is defaulted to main.
const baseSel = page.locator('[data-testid="pr-base"]');
const baseVal = await baseSel.inputValue();
if (baseVal !== 'main') fail(`expected base "main", got "${baseVal}"`);

// --- 2. Submit → status block lands in chat ----------------------------
const submit = page.locator('[data-testid="pr-submit"]');
await submit.click();

// Dialog should close.
await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {
  fail('PrDialog did not close after Open PR');
});

const statusBlock = page.locator('[data-testid="pr-status-block"]');
await statusBlock.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
  fail('pr-status block did not render');
});

const link = page.locator('[data-testid="pr-status-link"]');
const linkText = await link.innerText();
if (!linkText.includes('/pull/99')) fail(`expected PR URL in block, got "${linkText}"`);

// First poll is immediate → checks should render.
await page.waitForTimeout(400);
const checksText = await statusBlock.innerText();
if (!checksText.includes('test') || !checksText.includes('lint')) {
  fail(`expected checks "test" and "lint" in block, got:\n${checksText}`);
}

// Phase should be "done" since both checks are completed + success.
const phase = await statusBlock.getAttribute('data-pr-phase');
if (phase !== 'done') fail(`expected phase "done" after passing checks, got "${phase}"`);

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-pr] OK');
console.log('  /pr + Enter opens dialog with seeded title/base');
console.log('  Submit renders pr-status block with URL');
console.log('  Poll aggregates checks → phase=done');

await browser.close();
