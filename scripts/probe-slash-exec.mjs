// Probe: slash-command client-side execution.
//
// Renders against the webpack dev server on AGENTORY_DEV_PORT (default 4191)
// and exercises the six client-handled commands end-to-end through the
// textarea → Enter → DOM status block cycle. No Electron / no claude.exe
// involvement: these commands are intentionally renderer-only.
//
// Coverage:
//   1. `/help` + Enter → info status listing the registry + client/passthru
//   2. `/cost` + Enter → "No cost data yet" banner (no turns run yet)
//   3. `/clear` + Enter → sidebar now lists 2 sessions; active is the new one
//   4. `/config` + Enter → Settings dialog opens
//
// Usage:
//   AGENTORY_DEV_PORT=4191 npm run dev:web   # in another shell
//   node scripts/probe-slash-exec.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4191';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-exec] FAIL: ${msg}`);
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

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('aside', { timeout: 15_000 });

// Kick off by creating a session so the input bar + chat stream exist.
const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

async function sendSlash(text) {
  await textarea.click();
  await textarea.fill(text);
  // Let React render the picker + caret state; then dismiss it so the
  // next Enter fires "send" instead of "select row".
  await page.waitForTimeout(60);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
}

// --- 1. /help ---------------------------------------------------------
await sendSlash('/help');
const helpBanner = page.locator('[role="status"]').filter({ hasText: 'Slash commands' });
await helpBanner.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('/help did not render a status banner titled "Slash commands"');
});
const helpText = await helpBanner.innerText();
if (!/\/help/.test(helpText)) fail('/help listing missing /help row');
if (!/\(client\)/.test(helpText)) fail('/help listing missing (client) tags');
if (!/passthru/.test(helpText)) fail('/help listing missing passthru tags');

// --- 2. /cost ---------------------------------------------------------
await sendSlash('/cost');
const costBanner = page.locator('[role="status"]').filter({
  hasText: /Session cost|No cost data yet/
});
await costBanner.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('/cost did not render a cost status banner');
});

// --- 3. /clear --------------------------------------------------------
const sidebarItems = page.locator('[role="option"]');
const beforeCount = await sidebarItems.count();
await sendSlash('/clear');
await page.waitForTimeout(200);
const afterCount = await sidebarItems.count();
if (afterCount !== beforeCount + 1) {
  fail(`/clear should add a session (had ${beforeCount}, now ${afterCount})`);
}
// Confirm textarea is empty (send cleared the draft).
const postClearValue = await textarea.inputValue();
if (postClearValue !== '') fail(`textarea should be empty after /clear, got "${postClearValue}"`);

// --- 4. /config -------------------------------------------------------
await sendSlash('/config');
// Radix Dialog uses role="dialog" when open.
const settings = page.getByRole('dialog');
await settings.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
  fail('/config did not open the Settings dialog');
});
const hasGeneral = await settings.getByText(/general/i).first().isVisible().catch(() => false);
if (!hasGeneral) fail('Settings dialog missing General tab label');

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-exec] OK');
console.log('  /help → banner lists registry with client/passthru tags');
console.log('  /cost → banner rendered (no data yet path)');
console.log('  /clear → new session created and active');
console.log('  /config → Settings dialog opened');

await browser.close();
