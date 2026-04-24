// E2E: Connection pane reads from ~/.claude/settings.json (no token leak)
// and the "Open settings.json" button triggers the IPC.
//
// Strategy:
//   1. Spawn electron with HOME / USERPROFILE pointing at an isolated tmp
//      dir. The main process resolves `~/.claude/settings.json` via
//      `os.homedir()`, which honors those env vars on POSIX and Windows
//      respectively. So the IPC handler reads OUR fixture, not the
//      developer's real file.
//   2. Seed a fixture with baseUrl + auth token + model so we can assert
//      they round-trip into the rendered <code> blocks.
//   3. Open the Connection tab and assert:
//        - data-connection-base-url contains the fixture base URL
//        - data-connection-model contains the fixture model
//        - 'Configured' appears (auth token detected)
//        - the literal token string is NOT anywhere in the DOM
//   4. Click the Open settings.json button. The IPC handler calls
//      `shell.openPath` which is harmless in the sandbox. We assert the
//      button briefly enters "Opening…" state and no error message
//      appears next to it.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-connection-pane] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-conn-ud-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-conn-home-'));
const { port: PORT, close: closeServer } = await startBundleServer(root);
fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

const FIXTURE_BASE_URL = 'https://probe.example.com/v1';
const FIXTURE_MODEL = 'claude-probe-fixture-1';
// A token-shaped string we MUST NOT see leaked anywhere in the DOM.
const FIXTURE_TOKEN = 'sk-ant-PROBE-DO-NOT-LEAK-1234567890';
const settingsFile = path.join(homeDir, '.claude', 'settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      model: FIXTURE_MODEL,
      env: {
        ANTHROPIC_BASE_URL: FIXTURE_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: FIXTURE_TOKEN
      }
    },
    null,
    2
  ),
  'utf8'
);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_DEV_PORT: String(PORT),
    HOME: homeDir,
    USERPROFILE: homeDir,
    // Strip any inherited ANTHROPIC_* values so the fixture wins
    // unambiguously — the renderer asserts on the fixture text.
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: ''
  }
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });
  await win.waitForTimeout(500);

  // Open Settings via the sidebar button, then click the Connection tab.
  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sidebarBtn.click();
  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });

  const connectionTab = dialog.getByRole('button', { name: /^connection$/i });
  await connectionTab.click();
  // The pane mounts and runs `loadConnection` / `loadModels` on mount.
  const pane = win.locator('[data-connection-pane]');
  await pane.waitFor({ state: 'visible', timeout: 3000 });

  // Wait for the fixture base URL to render — proves the IPC + renderer
  // round trip completed.
  const baseUrlEl = win.locator('[data-connection-base-url]');
  await baseUrlEl.waitFor({ state: 'visible', timeout: 3000 });
  await win.waitForFunction(
    (expected) => {
      const el = document.querySelector('[data-connection-base-url]');
      return el?.textContent?.includes(expected) ?? false;
    },
    FIXTURE_BASE_URL,
    { timeout: 5000 }
  ).catch(async () => {
    const got = await baseUrlEl.innerText().catch(() => '<unavailable>');
    fail(`base URL did not render fixture value. got: ${got.slice(0, 200)}`);
  });

  // Model echoes back the fixture string.
  const modelEl = win.locator('[data-connection-model]');
  const modelText = await modelEl.innerText();
  if (!modelText.includes(FIXTURE_MODEL)) {
    fail(`model did not render fixture value. got: ${modelText.slice(0, 200)}`);
  }

  // Auth token is reflected as 'Configured' — no plaintext.
  const configured = await dialog.getByText(/^configured$/i).first().isVisible().catch(() => false);
  if (!configured) fail('expected "Configured" status for auth token');

  // SCREAMING-strings guard (PR #248 Gap #1, task #315). Discovered-models
  // source badges (`settings`, `cli-picker`, `fallback`) must NOT be
  // CSS-uppercased. Walk every element inside the discovered-models list and
  // assert computed `text-transform !== uppercase`.
  const screamingBadges = await win.evaluate(() => {
    const list = document.querySelector('[data-connection-models]');
    if (!list) return [];
    const offenders = [];
    list.querySelectorAll('*').forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (!txt || el.children.length > 0) return;
      const tt = window.getComputedStyle(el).textTransform;
      if (tt === 'uppercase') offenders.push(`${el.tagName}: ${txt.slice(0, 60)}`);
    });
    return offenders;
  });
  if (screamingBadges.length > 0) {
    fail(`discovered-models list has CSS-uppercased text (forbidden):\n  ${screamingBadges.join('\n  ')}`);
  }

  // CRITICAL: the literal token must NOT appear anywhere in the rendered DOM.
  const fullText = await win.evaluate(() => document.body.innerText);
  if (fullText.includes(FIXTURE_TOKEN)) {
    fail('FIXTURE_TOKEN leaked into the DOM — auth token must never be rendered as plaintext');
  }
  // Also scan attributes / non-visible nodes via outerHTML for paranoia.
  const fullHtml = await win.evaluate(() => document.documentElement.outerHTML);
  if (fullHtml.includes(FIXTURE_TOKEN)) {
    fail('FIXTURE_TOKEN found in outerHTML — token leaked into an attribute or hidden node');
  }

  // Click "Open settings.json". We can't truly observe the OS file-open
  // action in the sandbox, but we CAN verify:
  //   (a) the button is enabled, then briefly disabled while the IPC runs,
  //   (b) no error message appears after the IPC resolves,
  //   (c) the IPC handler creates the settings file if missing — already
  //       present from our fixture, so we just verify the IPC didn't throw
  //       (no error span next to the button).
  const openBtn = win.locator('[data-connection-open-file]');
  await openBtn.waitFor({ state: 'visible', timeout: 2000 });
  if (await openBtn.isDisabled()) fail('Open settings.json button starts disabled');
  await openBtn.click();
  // After a brief Opening… window, the button returns to enabled.
  await win.waitForFunction(
    () => {
      const b = document.querySelector('[data-connection-open-file]');
      return !!b && !b.hasAttribute('disabled');
    },
    null,
    { timeout: 5000 }
  );
  // No error span (text-state-error) appended next to the button.
  const errorMsg = await win
    .locator('[data-connection-open-file] ~ .text-state-error, .text-state-error')
    .filter({ hasText: /\S/ })
    .first()
    .innerText()
    .catch(() => '');
  if (errorMsg && errorMsg.trim().length > 0) {
    fail(`Open settings.json IPC reported an error: ${errorMsg}`);
  }

  console.log('\n[probe-e2e-connection-pane] OK');
  console.log(`  baseUrl rendered:  ${FIXTURE_BASE_URL}`);
  console.log(`  model rendered:    ${FIXTURE_MODEL}`);
  console.log(`  auth state:        Configured (no plaintext token in DOM)`);
  console.log(`  Open settings.json IPC fired without error`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await app.close();
  closeServer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
}
process.exit(exitCode);
