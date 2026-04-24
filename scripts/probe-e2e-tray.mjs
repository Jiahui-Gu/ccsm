// Verify minimize-to-tray:
// - Closing the window hides it (does NOT quit) on win32/linux
// - Window is recoverable by calling show() (proxy for tray click)
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-tray] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });

// Close → should hide, not quit. App must still be running and the window
// must still exist (just hidden).
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
  w?.close();
});
await new Promise((r) => setTimeout(r, 500));

const state = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
  return { exists: !!w, visible: w?.isVisible() ?? null };
});
if (!state.exists) fail('window was destroyed; expected hide-on-close');
if (state.visible !== false) fail(`window should be hidden after close; visible=${state.visible}`);

// Restore (tray click proxy)
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
  w?.show();
});
const after = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().startsWith('devtools://'));
  return w?.isVisible() ?? null;
});
if (after !== true) fail(`window should be visible after show; visible=${after}`);

console.log('[probe-e2e-tray] OK');
console.log(`  hide-on-close=true restore-via-show=true`);

// Set isQuitting via app menu/tray would be ideal; instead just force-kill.
await app.close();
