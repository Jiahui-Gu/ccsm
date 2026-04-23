// Regression probe: opening the StatusBar cwd popover must show the FULL
// Recent list, regardless of the active session's current cwd.
//
// Bug (pre-fix): `CwdPopover` seeded its query input with the current cwd
// AND ran filtering against that query, so opening the popover instantly
// collapsed Recent down to entries whose path contained the current cwd
// substring (often just the one entry equal to the current cwd).
//
// Fix: query starts empty on every open; the current cwd is shown as the
// input's placeholder so users still see "where am I" without it acting
// as a filter.
//
// Strategy:
//   1. Override the `import:recentCwds` IPC handler to return a known list
//      of 3 distinct paths.
//   2. Seed the renderer store with one session whose cwd matches the FIRST
//      recent entry — this is the worst case for the bug (the seeded query
//      would have matched exactly one item).
//   3. Click the cwd chip → assert dialog open + 3 options visible.
//   4. Type a substring matching ONE entry → assert it filters to 1.
//   5. Clear the input → assert all 3 visible again.
//
// Pre-fix verification (manual): change `useState('')` back to `useState(cwd)`
// in `src/components/CwdPopover.tsx:75` and rerun — step 3 will fail because
// only the matching entry is shown.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, seedStore } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-cwd-popover-recent-unfiltered] FAIL: ${msg}`);
  process.exit(1);
}

// Use POSIX-style paths so the substring "bar" assertion is unambiguous on
// any host. The popover treats paths as opaque strings so this is safe.
const RECENT = ['/proj/foo', '/work/bar', '/code/baz'];
const ACTIVE_CWD = RECENT[0];

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 15_000 });

// Replace the IPC handler so `defaultLoadRecent` returns our fixture.
await app.evaluate(async ({ ipcMain }, list) => {
  try { ipcMain.removeHandler('import:recentCwds'); } catch {}
  ipcMain.handle('import:recentCwds', () => list);
}, RECENT);

// Sanity-check the override took effect (renderer side).
const ipcReturn = await win.evaluate(async () => {
  return await window.agentory.recentCwds();
});
if (!Array.isArray(ipcReturn) || ipcReturn.length !== RECENT.length) {
  await app.close();
  fail(`IPC override failed: expected ${RECENT.length} entries, got ${JSON.stringify(ipcReturn)}`);
}

// Seed a single normal group + session with the active cwd.
await seedStore(win, {
  groups: [{ id: 'g1', name: 'Sessions', collapsed: false, kind: 'normal' }],
  sessions: [{
    id: 's1',
    groupId: 'g1',
    name: 'Test',
    state: 'idle',
    cwd: ACTIVE_CWD,
    cwdMissing: false,
    model: 'claude-sonnet-4-5',
    agentType: 'claude-code'
  }],
  activeId: 's1',
  tutorialSeen: true
});

// Find and click the cwd chip. CwdPopover's trigger has `data-cwd-chip`.
const trigger = win.locator('[data-cwd-chip]').first();
await trigger.waitFor({ state: 'visible', timeout: 10_000 });
await trigger.click();

const dialog = win.getByRole('dialog');
await dialog.waitFor({ state: 'visible', timeout: 5_000 });

// Wait for the loadRecent promise to resolve and options to render.
// Scope the option count to the dialog so other listboxes (e.g. Radix
// dropdowns elsewhere on the StatusBar) can't pollute the count.
await win.waitForFunction(
  (expected) => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return false;
    return dlg.querySelectorAll('[role="option"]').length === expected;
  },
  RECENT.length,
  { timeout: 5_000 }
).catch(async () => {
  const count = await dialog.locator('[role="option"]').count();
  const texts = await dialog.locator('[role="option"]').allTextContents();
  await app.close();
  fail(`expected ${RECENT.length} recent options on open, got ${count}: ${JSON.stringify(texts)}`);
});

// Verify each fixture path is rendered (truncateMiddle keeps short paths intact).
for (const p of RECENT) {
  const found = await dialog.locator('[role="option"]').filter({ hasText: p }).count();
  if (found === 0) { await app.close(); fail(`recent entry "${p}" not visible on open`); }
}

// Verify the input is empty and shows the cwd as placeholder.
const input = dialog.getByRole('textbox');
const initialValue = await input.inputValue();
if (initialValue !== '') { await app.close(); fail(`input value should be empty on open, got "${initialValue}"`); }
const placeholder = await input.getAttribute('placeholder');
if (!placeholder || !placeholder.includes('foo')) {
  await app.close();
  fail(`expected placeholder to surface current cwd "${ACTIVE_CWD}", got "${placeholder}"`);
}

// Type "bar" → expect 1 option.
await input.fill('bar');
await win.waitForFunction(
  () => {
    const dlg = document.querySelector('[role="dialog"]');
    return dlg && dlg.querySelectorAll('[role="option"]').length === 1;
  },
  null,
  { timeout: 3_000 }
).catch(async () => {
  const count = await dialog.locator('[role="option"]').count();
  await app.close();
  fail(`typing "bar" should filter to 1 option, got ${count}`);
});
const filteredText = await dialog.locator('[role="option"]').first().textContent();
if (!filteredText || !filteredText.includes('bar')) {
  await app.close();
  fail(`filtered option should contain "bar", got "${filteredText}"`);
}

// Clear → expect all 3 again.
await input.fill('');
await win.waitForFunction(
  (expected) => {
    const dlg = document.querySelector('[role="dialog"]');
    return dlg && dlg.querySelectorAll('[role="option"]').length === expected;
  },
  RECENT.length,
  { timeout: 3_000 }
).catch(async () => {
  const count = await dialog.locator('[role="option"]').count();
  await app.close();
  fail(`clearing input should restore all ${RECENT.length} options, got ${count}`);
});

console.log('\n[probe-e2e-cwd-popover-recent-unfiltered] OK');
console.log(`  open with active cwd "${ACTIVE_CWD}" → all ${RECENT.length} recent visible`);
console.log('  type "bar" → filters to 1; clear → restores 3');
console.log('  input value empty on open; placeholder surfaces current cwd');
await app.close();
