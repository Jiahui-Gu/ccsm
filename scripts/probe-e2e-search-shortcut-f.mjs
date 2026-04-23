// E2E: Search / Command Palette is bound to Cmd/Ctrl+F (was K).
//
// Asserts the rebind landed correctly:
//  1. Ctrl+F (Cmd+F on darwin) opens the palette — the search input becomes
//     visible.
//  2. Ctrl+F again toggles the palette closed.
//  3. Ctrl+K does NOT open the palette — that key is now unbound for the
//     search action. (Our app doesn't register Ctrl+K for anything else;
//     this guards against the old K binding being re-added accidentally.)
//
// Loads the freshly-built `dist/renderer/` via an isolated bundle server,
// matching the pattern in `probe-e2e-settings-open.mjs`. This is critical:
// pointing at a developer's running `npm run dev:web` would test STALE
// pre-rebuild code and produce a confusing pass/fail.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-search-shortcut-f] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-shortcut-f-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', AGENTORY_DEV_PORT: String(PORT) }
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 15_000 });
  await win.waitForTimeout(500);

  // The search input is the only <input> the CommandPalette renders. Its
  // placeholder comes from i18n (`commandPalette.searchPlaceholder`) — both
  // en + zh start the visible string with "Search" / "搜索", so a generic
  // selector wouldn't be locale-stable. We use the en string because the
  // app boots with English on a fresh userData dir (no preferences yet).
  const searchInput = win.locator('input[placeholder*="Search"]');

  const accel = process.platform === 'darwin' ? 'Meta' : 'Control';

  // 1. Cmd/Ctrl+F opens palette. App.tsx attaches the keydown listener on
  // window, so any focus is fine — but we wait a beat for React to settle
  // before pressing.
  await win.keyboard.press(`${accel}+f`);
  await searchInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
    fail('palette did not open via Ctrl+F — search input never appeared');
  });

  // 2. Cmd/Ctrl+F again closes it (App.tsx toggles paletteOpen on each press).
  // Press it on the input itself so the keydown reaches the global handler;
  // the palette's internal handlers shouldn't swallow F.
  await searchInput.focus();
  await win.keyboard.press(`${accel}+f`);
  await searchInput.waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {
    fail('palette did not close on second Ctrl+F (toggle broken)');
  });

  // 3. Cmd/Ctrl+K must NOT open the palette anymore.
  await win.keyboard.press(`${accel}+k`);
  await win.waitForTimeout(500);
  const openedByK = await searchInput.isVisible().catch(() => false);
  if (openedByK) {
    fail('Ctrl+K opened the palette — the K binding for search should be removed');
  }

  console.log('\n[probe-e2e-search-shortcut-f] OK');
  console.log('  Ctrl+F opens palette');
  console.log('  Ctrl+F toggles it closed');
  console.log('  Ctrl+K does NOT open palette');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await app.close();
  closeServer();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
