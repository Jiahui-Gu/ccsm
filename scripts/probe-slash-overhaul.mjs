// Probe: slash-command overhaul.
//
// Verifies the renderer-side wiring of the disk-based command loader:
//   1. Built-in /clear and /compact appear under a BUILT-IN group.
//   2. A stubbed `window.agentory.commands.list` returns user / project /
//      plugin commands; each surfaces under its own group with the right
//      label and (for plugin) the namespace prefix.
//   3. Selecting a dynamic command with no `argument-hint` clears the
//      textarea (it would have been pass-through-sent in the real app).
//   4. Selecting a dynamic command WITH `argument-hint` parks
//      "/<name> " in the textarea so the user can type args.
//
// Runs against the webpack dev server (no Electron needed). Stubs the
// preload bridge before the React tree mounts.
//
// Usage:
//   AGENTORY_DEV_PORT=4191 npm run dev:web   # in another shell
//   AGENTORY_DEV_PORT=4191 node scripts/probe-slash-overhaul.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4191';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-overhaul] FAIL: ${msg}`);
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

// Stub the preload bridge BEFORE any app script runs.
await page.addInitScript(() => {
  /** @type {any} */ (window).agentory = {
    commands: {
      list: async () => [
        {
          name: 'run-worker',
          description: 'Run the worker for a PR',
          source: 'user',
        },
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
      ],
    },
  };
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('aside', { timeout: 15_000 });

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

// Group headings present.
for (const label of [/Built-in/i, /User commands/i, /Project commands/i, /Plugin commands/i]) {
  const heading = picker.getByText(label);
  if (!(await heading.first().isVisible())) {
    fail(`group heading missing: ${label}`);
  }
}

// All five commands rendered: /clear /compact /run-worker /deploy /superpowers:brainstorm
const expectedNames = ['/clear', '/compact', '/run-worker', '/deploy', '/superpowers:brainstorm'];
for (const n of expectedNames) {
  if (!(await picker.getByText(n, { exact: true }).first().isVisible())) {
    fail(`command not visible in picker: ${n}`);
  }
}

// Argument hint chip on /deploy.
if (!(await picker.getByText('<env>').first().isVisible())) {
  fail('argument-hint badge "<env>" not visible for /deploy');
}

// --- Select dynamic command WITH argument-hint: parks `/deploy ` in input.
await textarea.fill('/dep');
await picker.waitFor({ state: 'visible', timeout: 1000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
const afterDeploy = await textarea.inputValue();
if (afterDeploy !== '/deploy ') {
  fail(`expected textarea "/deploy " after committing /deploy, got "${afterDeploy}"`);
}

// --- Select dynamic command WITHOUT argument-hint: clears textarea (would
// have sent in the real app; agentory api is stubbed so send is a no-op).
await textarea.fill('/run-w');
await picker.waitFor({ state: 'visible', timeout: 1000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
const afterRun = await textarea.inputValue();
if (afterRun !== '') {
  fail(`expected textarea cleared after committing /run-worker, got "${afterRun}"`);
}

// --- Plugin namespace lookup: typing /super filters down to the plugin one.
await textarea.fill('/super');
await picker.waitFor({ state: 'visible', timeout: 1000 });
const visibleSuper = await picker
  .getByText('/superpowers:brainstorm', { exact: true })
  .first()
  .isVisible();
if (!visibleSuper) fail('/superpowers:brainstorm not surfaced when filtering "super"');

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-overhaul] OK');
console.log('  picker shows BUILT-IN / USER / PROJECT / PLUGIN groups');
console.log('  /deploy commit parks "/deploy " in textarea (argument-hint path)');
console.log('  /run-worker commit clears textarea (one-shot pass-through path)');
console.log('  plugin-namespaced /superpowers:brainstorm filters correctly');

await browser.close();
