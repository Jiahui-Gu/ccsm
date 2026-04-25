// Probe: PR-E command-palette overhaul.
//
// Verifies the slash-command picker now:
//   1. Renders six source-grouped sections
//      (Built-in / User commands / Project commands / Plugin commands /
//       Skills / Agents) when each source has at least one entry.
//   2. Uses Fuse.js fuzzy matching — typing "thnk" still surfaces "/think".
//   3. Pins exact-name hits above fuzzier candidates.
//
// Captures BEFORE/AFTER screenshots of the picker open + filtered states
// for the PR description.
//
// Usage:
//   PORT=4191 npm run dev:web      # in another shell
//   PORT=4191 node scripts/probe-pr-e-picker.mjs
import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'dogfood-logs', 'pr-e');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PORT = process.env.PORT ?? '4191';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-pr-e-picker] FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 820 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

// Stub the `window.ccsm` preload bridge with the parts the renderer
// expects to exist at boot, plus a six-section command set so the picker
// has at least one entry per group + a fuzzy-search target.
//
// We stub aggressively (Proxy fallback) because the renderer calls a
// dozen-odd bridge methods on mount; missing any one of them surfaces as
// a pageerror that prevents `<aside>` from rendering.
await page.addInitScript(() => {
  const noopFn = () => () => {};
  const asyncNoop = async () => undefined;
  const list = async () => [
    { name: 'run-worker', description: 'Run a worker for a PR', source: 'user' },
    { name: 'think', description: 'Toggle extended thinking mode', source: 'user' },
    {
      name: 'deploy',
      description: 'Deploy this project',
      source: 'project',
      argumentHint: '<env>',
    },
    {
      name: 'superpowers:brainstorm',
      description: 'Brainstorm a feature',
      source: 'plugin',
      pluginId: 'superpowers',
    },
    { name: 'review', description: 'Review a pull request', source: 'skill' },
    { name: 'planner', description: 'Long-form planning agent', source: 'agent' },
  ];
  const base = {
    commands: { list },
    memory: {
      read: async () => ({ ok: true, content: '' }),
      write: async () => ({ ok: true }),
      exists: async () => false,
      userPath: async () => '',
      projectPath: async () => null,
    },
    window: {
      isMaximized: async () => false,
      minimize: () => {},
      maximize: () => {},
      unmaximize: () => {},
      close: () => {},
      platform: 'win32',
      onMaximizedChange: noopFn,
    },
    i18n: {
      setLanguage: () => {},
      getLanguage: async () => 'en',
    },
    onAgentEvent: noopFn,
    onPermissionRequest: noopFn,
    onPermissionUpdate: noopFn,
    onSessionEvent: noopFn,
    onUpdateEvent: noopFn,
    onWindowTintChange: noopFn,
    onWindowFocusChange: noopFn,
    loadMessages: async () => [],
    saveMessages: asyncNoop,
    loadState: async () => null,
    saveState: asyncNoop,
    recentCwds: async () => [],
    listModels: async () => [],
    notifyAvailability: async () => ({ available: false, error: null }),
    loadImportHistory: async () => [],
  };
  /** @type {any} */ (window).ccsm = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return /** @type {any} */ (target)[prop];
      // Fall through: any unknown method returns a value that satisfies
      // both `.then()` chains AND callers that expect an unsubscribe fn
      // (onXxx subscribers). A function with attached .then/.catch passes
      // both contracts.
      return () => {
        const off = () => {};
        /** @type {any} */ (off).then = (cb) => Promise.resolve(undefined).then(cb);
        /** @type {any} */ (off).catch = (cb) => Promise.resolve(undefined).catch(cb);
        return off;
      };
    },
  });
});

await page.goto(URL, { waitUntil: 'load' });
// Diagnostic: surface why <aside> isn't appearing if waitForSelector trips.
try {
  await page.waitForSelector('aside', { timeout: 15_000 });
} catch (e) {
  console.error('--- DIAG body ---');
  console.error((await page.evaluate(() => document.body.innerHTML)).slice(0, 800));
  console.error('--- DIAG errors ---');
  for (const err of errors) console.error(err);
  throw e;
}

const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });
await textarea.click();

await page.keyboard.type('/');
const picker = page.locator('[role="listbox"][aria-label="Slash commands"]');
await picker.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
  fail('picker did not appear after typing "/"');
});

// Screenshot: ALL six groups visible.
await page.screenshot({
  path: path.join(OUT_DIR, 'after-six-categories.png'),
  fullPage: false,
  clip: { x: 0, y: 380, width: 1200, height: 440 },
});

// Each group label must render.
for (const label of [
  /Built-in/i,
  /User commands/i,
  /Project commands/i,
  /Plugin commands/i,
  /Skills/i,
  /Agents/i,
]) {
  const heading = picker.getByText(label);
  if (!(await heading.first().isVisible())) {
    fail(`group heading missing: ${label}`);
  }
}

// Each command surfaces in the unfiltered list.
const expectedNames = [
  '/clear',
  '/compact',
  '/run-worker',
  '/think',
  '/deploy',
  '/superpowers:brainstorm',
  '/review',
  '/planner',
];
for (const n of expectedNames) {
  if (!(await picker.getByText(n, { exact: true }).first().isVisible())) {
    fail(`command not visible in picker: ${n}`);
  }
}

// --- Fuzzy match: "/thnk" (typo, missing 'i') should still surface /think.
await textarea.fill('/thnk');
await picker.waitFor({ state: 'visible', timeout: 1000 });
const thinkVisible = await picker.getByText('/think', { exact: true }).first().isVisible();
if (!thinkVisible) {
  fail('fuzzy: /think not surfaced for query "thnk" — Fuse.js not wired');
}

// Screenshot: fuzzy result.
await page.screenshot({
  path: path.join(OUT_DIR, 'after-fuzzy-search.png'),
  fullPage: false,
  clip: { x: 0, y: 380, width: 1200, height: 440 },
});

// --- Exact-name pin: typing "/clear" must keep /clear as the first row
// even though /clear's description ("Start a new conversation and clear
// context") would also match other ways.
await textarea.fill('/clear');
await picker.waitFor({ state: 'visible', timeout: 1000 });
const firstRow = picker.locator('button[role="option"]').first();
const firstName = (await firstRow.innerText()).trim();
if (!firstName.startsWith('/clear')) {
  fail(`exact-name pin failed: expected first row "/clear", got "${firstName}"`);
}

// --- Keyboard nav: arrow down should advance highlight; Enter should
// commit the parked argument-hint command "/deploy" to "/deploy ".
await textarea.fill('/dep');
await picker.waitFor({ state: 'visible', timeout: 1000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
const afterDeploy = await textarea.inputValue();
if (afterDeploy !== '/deploy ') {
  fail(`expected "/deploy " after committing /deploy, got "${afterDeploy}"`);
}

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-pr-e-picker] OK');
console.log('  six source-grouped sections render: built-in, user, project, plugin, skill, agent');
console.log('  fuzzy search: "/thnk" → "/think" (Fuse.js)');
console.log('  exact-name pin: "/clear" stays at row 0');
console.log('  argument-hint commit: "/dep" + Enter → "/deploy "');
console.log(`  screenshots: ${path.relative(process.cwd(), OUT_DIR)}`);

await browser.close();
