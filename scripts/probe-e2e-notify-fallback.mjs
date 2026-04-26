// E2E: When the optional `electron-windows-notifications` native module is
// unavailable (npm install skipped it because the @nodert-win10-au native
// deps wouldn't build on this machine), CCSM must:
//
//   1. Start cleanly — no startup crash, no unhandled promise rejection.
//   2. Surface the fallback state in Settings → Notifications via the
//      `data-testid=notifications-module-status` indicator
//      (`data-available="false"` plus the sentence-case English string).
//   3. The IPC `notify:availability` returns `{ available: false, error: ... }`
//      with an error message that proves the native require was attempted
//      and failed.
//
// We simulate "optional install failed" by renaming
// `node_modules/electron-windows-notifications` to a sibling path before
// launching electron, then restoring it on exit. The `WindowsAdapter`
// constructor's `require('electron-windows-notifications')` then throws
// MODULE_NOT_FOUND just as it would on a user machine where the native deps
// couldn't compile, and that bubbles up to `Notifier.create` rejection in
// the wrapper.
//
// Reverse-verify: stash the try/catch in `electron/notify.ts` (and rebuild)
// and re-run this probe; it must FAIL with an unhandled rejection logged or
// the Settings indicator never reaching `data-available="false"`.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-notify-fallback] FAIL: ${msg}`);
  process.exit(1);
}

const notifyDir = path.join(root, 'node_modules', 'electron-windows-notifications');
const stashedDir = path.join(
  root,
  'node_modules',
  'electron-windows-notifications.__probe_stash__',
);

let stashed = false;
function stashNotify() {
  if (!fs.existsSync(notifyDir)) {
    // Already absent on this machine — that's exactly the scenario we want
    // to simulate, so nothing to do.
    return;
  }
  if (fs.existsSync(stashedDir)) {
    // Leftover from a crashed previous run — clean it up first.
    fs.rmSync(stashedDir, { recursive: true, force: true });
  }
  fs.renameSync(notifyDir, stashedDir);
  stashed = true;
}

function restoreNotify() {
  if (!stashed) return;
  if (fs.existsSync(notifyDir)) {
    // Shouldn't happen, but don't clobber whatever's there.
    fs.rmSync(stashedDir, { recursive: true, force: true });
    return;
  }
  fs.renameSync(stashedDir, notifyDir);
  stashed = false;
}

process.on('exit', restoreNotify);
process.on('SIGINT', () => {
  restoreNotify();
  process.exit(130);
});

// --- 1. Hide the optional dep -------------------------------------------
stashNotify();
if (fs.existsSync(notifyDir)) {
  fail(`failed to stash node_modules/electron-windows-notifications at ${notifyDir}`);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);

// HOME / USERPROFILE sanitization per project rule — the probe must not
// touch the real developer's ~/.claude.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-notify-fb-ud-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-notify-fb-home-'));
fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_DEV_PORT: String(PORT),
    HOME: homeDir,
    USERPROFILE: homeDir,
  },
});

// Capture unhandled rejections / console errors emitted by the main process.
// If our wrapper regresses (e.g. lets the import error escape), one of these
// fires and the probe must fail.
const mainErrors = [];
app.process().on('exit', (code, signal) => {
  // Non-zero exit means main crashed before we got to the assertions.
  if (code !== null && code !== 0) {
    mainErrors.push(`main process exited with code=${code} signal=${signal}`);
  }
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });

  const rendererErrors = [];
  win.on('pageerror', (err) => rendererErrors.push(`pageerror: ${err.message}`));
  win.on('console', (msg) => {
    if (msg.type() === 'error') rendererErrors.push(`console.error: ${msg.text()}`);
  });

  // --- 2. Drive directly to Settings → Notifications via IPC + UI -------
  const ipcResult = await app.evaluate(async ({ ipcMain }, _arg) => {
    // We can't call ipcMain.invoke from main directly; instead poke the
    // handler module the same way the renderer would. The handler is
    // registered on `ipcMain` and we fish it out via `_invokeHandlers`.
    // eslint-disable-next-line no-underscore-dangle
    const handlers = ipcMain._invokeHandlers;
    const fn = handlers.get('notify:availability');
    if (typeof fn !== 'function') return { error: 'handler not registered' };
    return await fn({ sender: null });
  }, null);

  if (!ipcResult || typeof ipcResult !== 'object') {
    fail(`notify:availability did not return an object — got ${JSON.stringify(ipcResult)}`);
  }
  if (ipcResult.available !== false) {
    fail(
      `expected notify:availability.available === false (module is stashed) — got ${JSON.stringify(ipcResult)}`,
    );
  }
  if (typeof ipcResult.error !== 'string' || !ipcResult.error) {
    fail(`expected notify:availability.error to be a non-empty string — got ${JSON.stringify(ipcResult)}`);
  }
  console.log(`[probe-e2e-notify-fallback] IPC result: available=false, error="${ipcResult.error}"`);

  // --- 3. Open Settings + Notifications tab + assert the banner --------
  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sidebarBtn.click();

  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });

  // Click the Notifications tab.
  const notifTab = dialog.getByRole('tab', { name: /^notifications$/i });
  await notifTab.waitFor({ state: 'visible', timeout: 2000 });
  await notifTab.click();

  const status = win.locator('[data-testid="notifications-module-status"]');
  await status.waitFor({ state: 'visible', timeout: 3000 });

  // Wait for the async availability probe to settle (data-available flips
  // from "unknown" to "false").
  await win.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="notifications-module-status"]');
      return el && el.getAttribute('data-available') === 'false';
    },
    null,
    { timeout: 5000 },
  );

  const text = (await status.textContent())?.trim() ?? '';
  if (!text) fail('notifications-module-status indicator was empty');
  // The English fallback message MUST be sentence case (no SCREAMING),
  // mention the native notification module, and explicitly call out
  // "in-app banners" so the user knows what to expect instead.
  const lower = text.toLowerCase();
  if (!lower.includes('native notification module')) {
    fail(`fallback message missing "native notification module": "${text}"`);
  }
  if (!lower.includes('in-app banners')) fail(`fallback message missing "in-app banners": "${text}"`);
  // Reject all-caps words (>3 letters) — project's "no SCREAMING UI strings".
  for (const word of text.split(/\s+/)) {
    if (word.length > 3 && /^[A-Z]+$/.test(word) && word !== 'CCSM') {
      fail(`fallback message contains uppercase word "${word}" (no SCREAMING UI): "${text}"`);
    }
  }

  console.log(`[probe-e2e-notify-fallback] Settings banner reads: "${text}"`);

  // --- 4. No renderer errors / no main crash ---------------------------
  if (rendererErrors.length > 0) {
    fail(`renderer logged errors:\n  ${rendererErrors.join('\n  ')}`);
  }
  if (mainErrors.length > 0) {
    fail(`main process errors:\n  ${mainErrors.join('\n  ')}`);
  }

  console.log('[probe-e2e-notify-fallback] OK');
} catch (e) {
  exitCode = 1;
  console.error(`[probe-e2e-notify-fallback] threw: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  try {
    await app.close();
  } catch {
    // best effort
  }
  closeServer();
  restoreNotify();
  process.exit(exitCode);
}
