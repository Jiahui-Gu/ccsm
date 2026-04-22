// Probe: /help renders the registry locally and is NOT forwarded to claude.exe.
//
// Coverage:
//   1. Send `/help`.
//   2. A "Slash commands" status block appears in the chat stream.
//   3. The block lists at least the well-known commands: /help, /clear,
//      /config, /model, /cost, /pr, plus a pass-through example like /doctor.
//   4. Both `(client)` and `(passthru)` tags are present so users can tell
//      which commands hit Agentory vs the agent.
//   5. /help did NOT take the normal-message send path: no `user` block was
//      appended to the transcript (the dispatcher returned 'handled' before
//      the local-echo `appendBlocks` ran). This proves the command stayed
//      client-side and was not forwarded to claude.exe.
//   6. The textarea is empty afterwards (the /help text was consumed).
//
// Usage:
//   AGENTORY_DEV_PORT=4193 npm run dev:web   # in another shell
//   AGENTORY_DEV_PORT=4193 node scripts/probe-slash-help.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4193';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-help] FAIL: ${msg}`);
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

const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

await textarea.click();
await textarea.fill('/help');
await page.waitForTimeout(60);
await page.keyboard.press('Escape'); // dismiss the picker so Enter sends
await page.waitForTimeout(40);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);

// 1. Banner appears.
const banner = page.locator('[role="status"]').filter({ hasText: 'Slash commands' });
await banner.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('"Slash commands" status banner did not appear');
});

// 2. Banner lists key commands and category tags.
const text = await banner.first().innerText();
for (const needle of ['/help', '/clear', '/config', '/model', '/cost', '/pr', '/doctor']) {
  if (!text.includes(needle)) fail(`/help banner missing ${needle}`);
}
if (!text.includes('(client)')) fail('/help banner missing (client) tag');
if (!text.includes('(passthru)')) fail('/help banner missing (passthru) tag');
if (!/Commands starting with/.test(text)) {
  fail('/help banner missing the legend explaining the ⚠ marker');
}

// 3. Inspect the store: the only block in the transcript should be the
// "Slash commands" status. If /help had been forwarded, InputBar would have
// appended a `user` block (local echo) before invoking agentSend.
const blocks = await page.evaluate(() => {
  const store = /** @type {any} */ (window).__agentoryStore;
  const s = store.getState();
  return s.messagesBySession[s.activeId] ?? [];
});
if (!blocks) fail('window.__agentoryStore not exposed; cannot inspect transcript');
const userBlocks = blocks.filter((b) => b.kind === 'user');
if (userBlocks.length > 0) {
  fail(`/help must not echo a user block (forwarded path). Found: ${JSON.stringify(userBlocks)}`);
}
const statusBlocks = blocks.filter((b) => b.kind === 'status' && b.title === 'Slash commands');
if (statusBlocks.length !== 1) {
  fail(`expected exactly one "Slash commands" status block; got ${statusBlocks.length}`);
}

// 4. Textarea is empty.
const value = await textarea.inputValue();
if (value !== '') fail(`textarea should be empty after /help, got "${value}"`);

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-help] OK');
console.log('  /help rendered the registry banner with client + passthru tags');
console.log('  no user block echoed → handler stayed local (no claude.exe forward)');
console.log('  textarea cleared');

await browser.close();
