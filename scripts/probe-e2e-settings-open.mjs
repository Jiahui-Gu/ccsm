// E2E: Settings dialog open/close — multiple entry points reach ONE dialog,
// and Esc closes it.
//
// Surfaces under test:
//   1. Sidebar Settings button (aria-label 'Settings'/'设置')
//   2. `/config` slash command in the textarea
//   3. Keyboard shortcut Cmd+, / Ctrl+,
//
// All three must open the same Radix dialog (role='dialog'). After each
// open, Esc must close it (Radix wires this by default — the test guards
// against a future regression where someone wraps DialogContent and eats
// the Esc keydown). We also assert the tabs nav (`Connection` etc.) is
// rendered so we know it's the SettingsDialog and not some other dialog.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-settings-open] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-settings-open-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_DEV_PORT: String(PORT) }
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });
  await win.waitForTimeout(500);

  // --- Helper: open the dialog via a given trigger, return its handle ----
  const dialog = win.getByRole('dialog');

  async function expectDialogClosed(label) {
    // Radix removes the dialog content from the DOM after the close
    // animation; allow up to 1.5s for that.
    await dialog.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
    if ((await dialog.count()) > 0) fail(`${label}: dialog still in DOM after expected close`);
  }

  async function expectSettingsDialogOpen(label) {
    await dialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
      fail(`${label}: dialog never became visible`);
    });
    // Confirm it's the Settings dialog by checking for the tab nav. We use
    // the i18n-stable 'Connection' tab name (English locale boots first).
    const conn = dialog.getByRole('tab', { name: /^connection$/i });
    await conn.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {
      fail(`${label}: Settings tabs not visible — wrong dialog opened?`);
    });
  }

  async function pressEscAndExpectClosed(label) {
    await win.keyboard.press('Escape');
    await expectDialogClosed(label);
  }

  // --- 1. Sidebar Settings button ----------------------------------------
  // The button is rendered with aria-label='Settings' (i18n 'sidebar.settingsAria').
  // There are two Settings-labelled controls in the sidebar (collapsed vs
  // expanded layout) — `.first()` is fine because only one is visible.
  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sidebarBtn.click();
  await expectSettingsDialogOpen('sidebar button');
  await pressEscAndExpectClosed('sidebar button');

  // --- 2. `/config` slash command ----------------------------------------
  // Need a session for the InputBar to render. Create one if absent.
  if (!(await win.locator('textarea').first().isVisible().catch(() => false))) {
    const newBtn = win.getByRole('button', { name: /new session/i }).first();
    await newBtn.click();
  }
  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  await textarea.click();
  await textarea.fill('/config');
  // The slash picker may steal Enter — dismiss it first.
  await win.waitForTimeout(80);
  await win.keyboard.press('Escape');
  // Esc may have closed the picker AND any leftover dialog; that's fine.
  await win.waitForTimeout(80);
  await win.keyboard.press('Enter');
  await expectSettingsDialogOpen('/config');
  await pressEscAndExpectClosed('/config');

  // --- 3. Keyboard shortcut (Cmd+, / Ctrl+,) -----------------------------
  // App.tsx wires both metaKey and ctrlKey + ',' to setSettingsOpen(true).
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control';
  // Make sure the textarea isn't holding focus on a leftover '/config' draft.
  await textarea.fill('');
  await win.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await win.keyboard.press(`${accel}+,`);
  await expectSettingsDialogOpen('keyboard shortcut');
  await pressEscAndExpectClosed('keyboard shortcut');

  console.log('\n[probe-e2e-settings-open] OK');
  console.log('  sidebar button, /config slash, and Cmd+, all open the same Settings dialog');
  console.log('  Esc closes it from each entry point');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await app.close();
  closeServer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
