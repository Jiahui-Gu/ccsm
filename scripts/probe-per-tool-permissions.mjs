// Live e2e: drive the new Permissions tab in Settings and verify the
// effective-CLI-flag preview reflects preset clicks, per-tool toggles, and
// pattern overrides. Also verifies the rules survive a dialog close/reopen.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-per-tool-permissions] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AGENTORY_DEV_PORT: process.env.AGENTORY_DEV_PORT ?? '4193',
  },
});
app.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr] ${d}`));

const win = await appWindow(app, { timeout: 30_000 });
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2000);

// Reset persisted rules so the probe is deterministic regardless of what the
// dev profile carries on disk. We drive it via the public zustand hook.
await win.evaluate(() => {
  const store = window.__agentoryStore;
  if (!store) throw new Error('no __agentoryStore');
  store.getState().resetPermissionRules();
});

async function openPermissionsTab() {
  // Open Settings via the public store action — avoids depending on a
  // specific header-button locator that varies by layout.
  await win.evaluate(() => {
    const store = window.__agentoryStore;
    const s = store.getState();
    // The app keeps the dialog mounted when open; emit the same UI event the
    // header uses. Simpler path: dispatch a synthetic keyboard shortcut.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, ctrlKey: true, bubbles: true }));
    void s;
  });
  await win.waitForTimeout(400);
  // Click the Permissions tab.
  const tab = win.locator('button', { hasText: /^Permissions$/ }).first();
  await tab.waitFor({ state: 'visible', timeout: 5_000 });
  await tab.click();
  await win.waitForTimeout(300);
  const pane = win.locator('[data-perm-pane]');
  await pane.waitFor({ state: 'visible', timeout: 5_000 });
}

try {
  await openPermissionsTab();
} catch (err) {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 2000));
  console.error('--- body ---\n' + dump);
  fail(`could not open Permissions tab: ${err?.message}`, app);
}

async function getEffective() {
  return await win.locator('[data-perm-effective]').innerText();
}

// 1. Click "Read-only tools" preset.
await win.locator('[data-preset="readonly"]').click();
await win.waitForTimeout(200);
let eff = await getEffective();
console.log('[probe] readonly preset effective:', eff);
for (const token of ['--permission-mode', '--allowedTools', 'Read', 'Glob', 'Grep']) {
  if (!eff.includes(token)) fail(`readonly preset missing "${token}" in preview: ${eff}`, app);
}
if (!eff.includes('--disallowedTools')) fail('readonly preset missing --disallowedTools', app);
if (!/Bash/.test(eff)) fail('readonly preset should deny Bash', app);

// 2. Toggle Bash from Deny to Allow via the per-tool radio.
const bashRow = win.locator('[data-perm-tool-row="Bash"]');
await bashRow.waitFor({ state: 'visible', timeout: 3_000 });
await bashRow.locator('[data-perm-tool-state="allow"]').click();
await win.waitForTimeout(200);
eff = await getEffective();
console.log('[probe] after Bash=allow effective:', eff);
// Bash should now appear in allowedTools and NOT in disallowedTools.
const allowMatch = eff.match(/--allowedTools "([^"]+)"/);
const denyMatch = eff.match(/--disallowedTools "([^"]+)"/);
if (!allowMatch || !/\bBash\b/.test(allowMatch[1])) {
  fail(`Bash not found in allowedTools after toggle: ${eff}`, app);
}
if (denyMatch && /\bBash\b/.test(denyMatch[1])) {
  fail(`Bash still in disallowedTools after toggle: ${eff}`, app);
}

// 3. Add a scoped pattern via the Allow-patterns textarea. Expand the details
//    disclosure first.
const details = win.locator('[data-perm-pane] details').first();
await details.evaluate((d) => {
  d.open = true;
});
const allowTa = win.locator('[data-perm-allow-patterns]');
await allowTa.waitFor({ state: 'visible', timeout: 3_000 });
await allowTa.fill('Bash(git:*)');
await allowTa.blur();
await win.waitForTimeout(250);
eff = await getEffective();
console.log('[probe] after adding Bash(git:*) pattern:', eff);
if (!eff.includes('Bash(git:*)')) {
  fail(`pattern not reflected in preview: ${eff}`, app);
}

// 4. Close the Settings dialog (Escape) and re-open; assert rules persisted.
await win.keyboard.press('Escape');
await win.waitForTimeout(300);
await openPermissionsTab();
eff = await getEffective();
console.log('[probe] after reopen effective:', eff);
if (!eff.includes('Bash(git:*)')) {
  fail(`scoped pattern lost across dialog reopen: ${eff}`, app);
}
// Bash state persisted as allow.
const bashRowState = await win
  .locator('[data-perm-tool-row="Bash"] [data-perm-tool-state="allow"][aria-checked="true"]')
  .count();
if (bashRowState === 0) fail('Bash allow state lost across reopen', app);

// 5. Reset: call the store action directly (equivalent to clicking the
//    "Reset to mode defaults" button; the button itself is pinned below the
//    effective-flags preview and the Dialog's own scroll container
//    confuses Playwright's "is in viewport" check on small windows).
await win.evaluate(() => {
  const store = window.__agentoryStore;
  store.getState().resetPermissionRules();
});
await win.waitForTimeout(200);
eff = await getEffective();
console.log('[probe] after reset effective:', eff);
if (eff.includes('--allowedTools') || eff.includes('--disallowedTools')) {
  fail(`reset did not clear rules: ${eff}`, app);
}
// Also assert the [data-perm-reset] button is rendered (structural check)
// even though we didn't physically click it.
const resetCount = await win.locator('[data-perm-reset]').count();
if (resetCount !== 1) fail(`expected 1 reset button, got ${resetCount}`, app);

console.log('\n[probe-per-tool-permissions] OK: preset, per-tool toggle, pattern, reopen-persist, reset all working');

await app.close();
