// Probe: in-chat slash-command picker.
//
// Strategy: render against the webpack dev server on AGENTORY_DEV_PORT
// (defaults to 4184), create a session, and exercise the picker purely
// through keyboard + DOM. No Electron / no agent IPC needed — the picker
// is pure DOM/state.
//
// Coverage:
//   1. Typing `/` at start of input opens the picker with all commands.
//   2. Typing `cl` filters down to /clear and highlights it.
//   3. ArrowDown + Enter replaces textarea value with `/<name> ` and closes
//      the picker (value NOT sent).
//   4. A space after the command keeps the picker closed (composing args).
//   5. Escape closes the picker without wiping the textarea value.
//   6. A mid-sentence `/` does NOT open the picker.
//
// Usage:
//   AGENTORY_DEV_PORT=4184 npm run dev:web   # in another shell
//   node scripts/probe-slash-commands.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4184';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-commands] FAIL: ${msg}`);
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

// --- 1. Type `/` → picker opens with all commands ---------------------
await page.keyboard.type('/');
const picker = page.locator('[role="listbox"][aria-label="Slash commands"]');
await picker.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
  fail('picker did not appear after typing "/"');
});
const allOptions = await picker.locator('[role="option"]').count();
if (allOptions < 5) {
  fail(`expected many commands in picker, got ${allOptions}`);
}

// --- 2. Type `cl` → filter narrows, /clear visible & highlighted ------
await page.keyboard.type('cl');
await page.waitForTimeout(80);
const clearRow = picker.getByText('/clear');
if (!(await clearRow.isVisible())) fail('/clear not visible after filtering by "cl"');
const selected = await picker.locator('[role="option"][aria-selected="true"]').innerText();
if (!selected.includes('/clear')) {
  fail(`expected /clear highlighted, got "${selected}"`);
}

// --- 3. ArrowDown + Enter commits (caveat: /clear is first, ArrowDown
//        would move OFF it — so just hit Enter on the already-highlighted
//        row). Then assert textarea = "/clear " and picker closed. -----
await page.keyboard.press('Enter');
await page.waitForTimeout(80);
const valueAfterEnter = await textarea.inputValue();
if (valueAfterEnter !== '/clear ') {
  fail(`expected textarea value "/clear ", got "${valueAfterEnter}"`);
}
const pickerVisibleAfterEnter = await picker.isVisible().catch(() => false);
if (pickerVisibleAfterEnter) {
  fail('picker should have closed after Enter-commit');
}

// --- 4. Space-in-first-token closes picker. Already closed due to the
//        trailing space from commit. Type more text, assert still closed.
await page.keyboard.type('now');
await page.waitForTimeout(50);
if (await picker.isVisible().catch(() => false)) {
  fail('picker should stay closed after commit + arg typing');
}

// --- 5. Escape closes the picker without wiping textarea value --------
await textarea.fill('/he');
await picker.waitFor({ state: 'visible', timeout: 1000 });
await page.keyboard.press('Escape');
await page.waitForTimeout(50);
if (await picker.isVisible().catch(() => false)) {
  fail('picker should close on Escape');
}
const valueAfterEsc = await textarea.inputValue();
if (valueAfterEsc !== '/he') {
  fail(`expected textarea to retain "/he" after Escape, got "${valueAfterEsc}"`);
}

// --- 6. Mid-sentence `/` does NOT open picker --------------------------
await textarea.fill('hey /help me');
await page.waitForTimeout(50);
if (await picker.isVisible().catch(() => false)) {
  fail('picker must not open for a mid-sentence "/"');
}

// Also: a message that starts with `/` but has a space already closes the
// picker (covered by step 4, repeated for clarity).
await textarea.fill('/help ');
await page.waitForTimeout(50);
if (await picker.isVisible().catch(() => false)) {
  fail('picker must not stay open once user typed a space after /name');
}

// Filter down to nothing → empty-state message ------------------------
await textarea.fill('/xyznope');
await picker.waitFor({ state: 'visible', timeout: 1000 });
const emptyVisible = await picker.getByText(/No matching commands/i).isVisible();
if (!emptyVisible) fail('empty-state message missing for no-match query');

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-commands] OK');
console.log(`  ${allOptions} commands rendered on bare slash`);
console.log('  /cl → /clear highlighted; Enter → textarea="/clear "');
console.log('  Escape keeps value, mid-sentence / stays closed');

await browser.close();
