// E2E: command palette keyboard navigation.
//
// 1. Cmd/Ctrl+F opens the palette.
// 2. After typing, ↓ moves the active row, ↑ moves it back.
// 3. Enter on an active session row closes the palette AND selects that
//    session (activeId in the store flips).
//
// Catches regressions in CommandPalette.onKeyDown (active index math) and in
// the picker plumbing (App.tsx onSelectSession wiring).
//
// Pure black-box for the palette UI; the activeId assertion uses the
// public __ccsmStore handle the app already exposes for E2E.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-palette-nav] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-palette-nav-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try { // ccsm-probe-cleanup-wrap

const errors = [];
const win = await appWindow(app);
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10_000 });

// Seed: TWO sessions whose names share the prefix "session" so the palette
// produces ≥2 result rows when we type "session", letting us exercise both
// ↓ and ↑.
await win.evaluate(() => {
  window.__ccsmStore.setState({
    sessions: [
      {
        id: 's-nav-A',
        name: 'session alpha',
        state: 'idle',
        cwd: '~/a',
        model: 'claude-opus-4',
        groupId: 'g-default',
        agentType: 'claude-code'
      },
      {
        id: 's-nav-B',
        name: 'session bravo',
        state: 'idle',
        cwd: '~/b',
        model: 'claude-opus-4',
        groupId: 'g-default',
        agentType: 'claude-code'
      }
    ],
    groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    activeId: 's-nav-A',
    tutorialSeen: true
  });
});
await win.waitForTimeout(200);

// 1. Open palette via global shortcut.
await win.evaluate(() => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true })
  );
});

const searchInput = win.locator('input[placeholder*="Search"]');
await searchInput.waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
  await app.close();
  fail('palette did not open via Ctrl+F');
});

// 2. Type "session bravo" and confirm Enter routes to bravo by checking
//    activeId AFTER Enter — but first verify ↑/↓ navigation works.
await searchInput.click();
await searchInput.fill('session');
await win.waitForTimeout(150);

const paletteDialog = win.locator('[role="dialog"]').filter({ has: win.locator('input[placeholder*="Search"]') });
const options = paletteDialog.locator('[role="option"]');
const optionCount = await options.count();
if (optionCount < 2) {
  await app.close();
  fail(`expected ≥2 option rows after typing "session", got ${optionCount}`);
}

// Initial active = index 0 (first row, "session alpha").
async function activeIndex() {
  const flags = await options.evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-selected') === 'true')
  );
  return flags.indexOf(true);
}

let idx = await activeIndex();
if (idx !== 0) {
  await app.close();
  fail(`initial active index expected 0, got ${idx}`);
}

// ↓ should move to row 1.
await searchInput.press('ArrowDown');
await win.waitForTimeout(80);
idx = await activeIndex();
if (idx !== 1) {
  await app.close();
  fail(`after ArrowDown, expected active=1, got ${idx}`);
}

// ↑ should move back to row 0.
await searchInput.press('ArrowUp');
await win.waitForTimeout(80);
idx = await activeIndex();
if (idx !== 0) {
  await app.close();
  fail(`after ArrowUp, expected active=0, got ${idx}`);
}

// 3. Move to "session bravo" specifically and Enter to commit. We can't
//    blindly trust order — locate bravo's index and arrow-down to it.
const labels = await options.evaluateAll((els) =>
  els.map((el) => el.textContent?.trim() ?? '')
);
const bravoIdx = labels.findIndex((l) => l.includes('bravo'));
if (bravoIdx < 0) {
  await app.close();
  fail(`"session bravo" row not present in palette results: ${JSON.stringify(labels)}`);
}
const steps = bravoIdx - (await activeIndex());
for (let i = 0; i < steps; i++) await searchInput.press('ArrowDown');
await win.waitForTimeout(80);

// Confirm.
await searchInput.press('Enter');
await win.waitForTimeout(400);

// Palette should have closed AND activeId should be 's-nav-B'. Check activeId
// first — that's the load-bearing assertion (the dialog close is incidental).
const activeId = await win.evaluate(() => window.__ccsmStore.getState().activeId);
if (activeId !== 's-nav-B') {
  const dump = await win.evaluate(() => ({
    listboxes: Array.from(document.querySelectorAll('[role="dialog"] [role="option"]')).map((el) => ({
      label: el.textContent?.trim(),
      selected: el.getAttribute('aria-selected')
    }))
  }));
  console.error('--- palette options at failure ---\n' + JSON.stringify(dump, null, 2));
  await app.close();
  fail(`Enter on "session bravo" did not select s-nav-B; activeId=${activeId}`);
}

const stillOpen = await searchInput.isVisible().catch(() => false);
if (stillOpen) {
  await app.close();
  fail('palette did not close after Enter');
}

console.log('\n[probe-e2e-palette-nav] OK');
console.log('  Ctrl+F opens palette');
console.log('  ArrowDown/ArrowUp move active row');
console.log('  Enter on "session bravo" closes palette and sets activeId=s-nav-B');

await app.close();

try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
