// Probe: `/model` slash-command opens the in-chat model picker, lists every
// model from the store (which is what `loadModels()` populates from
// ~/.claude/settings.json + env), lets the user select one, and surfaces the
// choice through `setModel` so subsequent messages use the new model.
//
// Renders against the webpack dev server on AGENTORY_DEV_PORT (default 4192)
// and seeds the renderer store directly via `window.__agentoryStore` since
// the dev server has no Electron / no `models:list` IPC behind it.
//
// Usage:
//   AGENTORY_DEV_PORT=4192 npm run dev:web   # in another shell
//   node scripts/probe-slash-model.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4192';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-model] FAIL: ${msg}`);
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

// Seed models into the store so the picker has something to render. In real
// runs this comes from `loadModels()` reading ~/.claude/settings.json (the
// `settings`-source entries) plus env-derived ones — we mimic both sources
// here. The picker doesn't care where they came from; it just lists `.id`
// and `.source`.
await page.evaluate(() => {
  const store = window.__agentoryStore;
  if (!store) throw new Error('window.__agentoryStore not exposed (dev only)');
  store.setState({
    models: [
      { id: 'claude-opus-4-5-20251101', source: 'settings' },
      { id: 'claude-sonnet-4-5-20250929', source: 'settings' },
      { id: 'claude-haiku-4-5-20251001', source: 'env' }
    ],
    modelsLoaded: true
  });
});

// Open / create a session so InputBar exists. The slash dispatcher needs a
// session id to invoke the handler against.
const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

// Type `/model`, dismiss the picker (so Enter sends instead of selecting a
// row), then send.
await textarea.click();
await textarea.fill('/model');
await page.waitForTimeout(60);
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
await page.keyboard.press('Enter');

// --- 1. Picker dialog appears -----------------------------------------
const dialog = page.getByRole('dialog');
await dialog.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
  fail('/model did not open a model picker dialog');
});

const titleVisible = await dialog
  .getByText(/switch model/i)
  .first()
  .isVisible()
  .catch(() => false);
if (!titleVisible) fail('model picker dialog missing the "Switch model" title');

// --- 2. Lists exactly the 3 seeded models with their source tags ------
const listbox = dialog.locator('[role="listbox"]');
await listbox.waitFor({ state: 'visible', timeout: 2000 });
const options = listbox.locator('[role="option"]');
const count = await options.count();
if (count !== 3) fail(`expected 3 model rows, got ${count}`);

const listText = await listbox.innerText();
for (const id of ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001']) {
  if (!listText.includes(id)) fail(`model "${id}" missing from picker`);
}
if (!/settings/.test(listText)) fail('source tag "settings" missing from picker');
if (!/env/.test(listText)) fail('source tag "env" missing from picker');

// --- 3. Click the second model → store.model + active session model
//        update, dialog closes, no settings-dialog gets opened. ---------
const before = await page.evaluate(() => {
  const s = window.__agentoryStore.getState();
  return {
    model: s.model,
    activeModel: s.sessions.find((x) => x.id === s.activeId)?.model ?? null
  };
});

await options.nth(1).click();
await page.waitForTimeout(150);

const dialogVisibleAfter = await dialog.isVisible().catch(() => false);
if (dialogVisibleAfter) fail('model picker did not close after selection');

const after = await page.evaluate(() => {
  const s = window.__agentoryStore.getState();
  return {
    model: s.model,
    activeModel: s.sessions.find((x) => x.id === s.activeId)?.model ?? null
  };
});

if (after.model !== 'claude-sonnet-4-5-20250929') {
  fail(`store.model not updated; before=${before.model} after=${after.model}`);
}
if (after.activeModel !== 'claude-sonnet-4-5-20250929') {
  fail(`active session model not updated; before=${before.activeModel} after=${after.activeModel}`);
}

// --- 4. /model must NOT have opened the Settings dialog ---------------
//        (regression: previous handler routed to Settings → Connection.)
//        At this point the model-picker dialog is closed; if Settings had
//        opened it would still be in the DOM as role=dialog with the
//        "General" / "Appearance" headings.
const stillOpenDialog = page.getByRole('dialog');
const stillOpen = await stillOpenDialog.isVisible().catch(() => false);
if (stillOpen) {
  const txt = await stillOpenDialog.innerText().catch(() => '');
  if (/general|appearance|connection/i.test(txt)) {
    fail(`/model leaked into Settings dialog; saw "${txt.slice(0, 80)}…"`);
  }
}

// --- 5. Sanity: the StatusBar model chip now shows the picked model ---
const chipText = await page.locator('button:has-text("claude-sonnet-4-5-20250929")').first().isVisible().catch(() => false);
if (!chipText) {
  // Non-fatal: chip rendering is covered elsewhere. Log only.
  console.warn('[probe-slash-model] note: status-bar chip did not show new model id (non-fatal)');
}

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-model] OK');
console.log('  /model → picker opened with 3 models (settings + env sources)');
console.log('  click → store.model + active session model updated');
console.log('  no Settings dialog leak');

await browser.close();
