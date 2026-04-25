// E2E: Settings dialog renders Chinese strings end-to-end when language='zh'.
//
// Boots the app, force-flips language to Chinese via the Appearance pane's
// segmented control, then walks Appearance / Notifications / Updates /
// Connection. For each pane, asserts that 2-3 known labels render with the
// translated Chinese string (and not the English source). This guards
// against the regression "key added to en.ts/zh.ts but never wired into
// the component", which the parity test cannot catch.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-i18n-settings-zh] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-i18n-settings-zh-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_DEV_PORT: String(PORT),
    LANG: 'en_US.UTF-8'
  }
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });
  await win.waitForTimeout(400);

  async function openSettings() {
    const dialog = win.getByRole('dialog');
    if ((await dialog.count()) === 0) {
      const btn = win.getByRole('button', { name: /^(settings|设置)$/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click();
    }
    await dialog.waitFor({ state: 'visible', timeout: 3000 });
    return dialog;
  }
  async function closeDialog() {
    await win.keyboard.press('Escape');
    await win.getByRole('dialog').waitFor({ state: 'hidden', timeout: 1500 }).catch(() => {});
  }

  // --- Force Chinese via the Appearance pane's Language segmented ----
  let dialog = await openSettings();
  // Default tab is Appearance — Language radio is named '中文' (label key
  // settings.languageOptions.zh stays '中文' in both catalogs).
  const zhRadio = dialog.getByRole('radio', { name: /^中文$/ });
  await zhRadio.waitFor({ state: 'visible', timeout: 3000 });
  await zhRadio.click();
  await win.waitForTimeout(250);

  // Helper: switch to a tab by its (now Chinese) label.
  async function switchTab(name) {
    const tab = dialog.getByRole('tab', { name });
    await tab.waitFor({ state: 'visible', timeout: 2000 });
    await tab.click();
    await win.waitForTimeout(150);
  }

  function assertHasText(haystack, needle, where) {
    if (!haystack.includes(needle)) {
      fail(`${where}: expected to find "${needle}" in pane text. Got snippet:\n${haystack.slice(0, 800)}`);
    }
  }
  function assertNotHasText(haystack, needle, where) {
    if (haystack.includes(needle)) {
      fail(`${where}: unexpected English string "${needle}" leaked into zh pane.\n${haystack.slice(0, 800)}`);
    }
  }

  async function paneText() {
    return await dialog.evaluate((el) => {
      // The pane area is the .overflow-y-auto sibling of the tab nav. Fall
      // back to the whole dialog text if that selector ever drifts.
      const main = el.querySelector('div.overflow-y-auto');
      return ((main && main.textContent) || el.textContent || '').trim();
    });
  }

  // --- 1. Appearance (already showing) ----
  let txt = await paneText();
  assertHasText(txt, '主题', 'appearance');
  assertHasText(txt, '字号', 'appearance');
  assertHasText(txt, '密度', 'appearance');
  assertNotHasText(txt, 'Theme', 'appearance');
  assertNotHasText(txt, 'Density', 'appearance');

  // --- 2. Notifications ----
  await switchTab(/^通知$/);
  txt = await paneText();
  assertHasText(txt, '启用通知', 'notifications');
  assertHasText(txt, '权限请求', 'notifications');
  assertHasText(txt, '发送测试通知', 'notifications');
  assertNotHasText(txt, 'Enable notifications', 'notifications');
  assertNotHasText(txt, 'Test notification', 'notifications');

  // --- 3. Updates ----
  await switchTab(/^更新$/);
  txt = await paneText();
  assertHasText(txt, '版本', 'updates');
  assertHasText(txt, '检查更新', 'updates');
  assertHasText(txt, '自动检查', 'updates');
  assertNotHasText(txt, 'Check for updates', 'updates');
  assertNotHasText(txt, 'Automatic checks', 'updates');

  // --- 4. Connection ----
  await switchTab(/^连接$/);
  txt = await paneText();
  assertHasText(txt, '默认模型', 'connection');
  assertHasText(txt, 'Auth Token', 'connection');
  assertHasText(txt, '打开 settings.json', 'connection');
  assertNotHasText(txt, 'Default model', 'connection');
  assertNotHasText(txt, 'Open settings.json', 'connection');

  await closeDialog();

  console.log('\n[probe-e2e-i18n-settings-zh] OK');
  console.log('  Appearance / Notifications / Updates / Connection panes all render Chinese labels');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await app.close();
  closeServer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
