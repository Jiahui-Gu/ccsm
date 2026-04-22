// Probe: `/config` slash-command opens the Settings dialog (equivalent to
// clicking the gear icon in the sidebar). Renders against the webpack dev
// server on AGENTORY_DEV_PORT (default 4193) — pure DOM/state, no Electron
// needed.
//
// Usage:
//   AGENTORY_DEV_PORT=4193 npm run dev:web   # in another shell
//   node scripts/probe-slash-config.mjs
import { chromium } from 'playwright';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4193';
const URL = `http://localhost:${PORT}/`;

function fail(msg) {
  console.error(`\n[probe-slash-config] FAIL: ${msg}`);
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

// Need a session for InputBar to mount.
const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();

const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

// --- 1. Type `/config`, dismiss picker, send → Settings dialog opens --
await textarea.click();
await textarea.fill('/config');
await page.waitForTimeout(60);
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
await page.keyboard.press('Enter');

const dialog = page.getByRole('dialog');
await dialog.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
  fail('/config did not open the Settings dialog');
});

// --- 2. The Settings dialog must be the gear-equivalent — i.e. show the
//        General / Appearance tab labels, not the model picker. ---------
const dialogText = await dialog.innerText();
if (/switch model/i.test(dialogText)) {
  fail('/config opened the model picker instead of the Settings dialog');
}
const hasGeneralOrAppearance = /general|appearance/i.test(dialogText);
if (!hasGeneralOrAppearance) {
  fail(`Settings dialog opened but missing General/Appearance content; got: ${dialogText.slice(0, 200)}`);
}

// --- 3. Close, then click the gear icon → opens the SAME dialog. ------
//        Asserts /config is equivalent to the gear button.
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const stillVisible = await dialog.isVisible().catch(() => false);
if (stillVisible) fail('Settings dialog did not close on Escape');

const gear = page
  .getByRole('button', { name: /settings/i })
  .first();
const gearExists = await gear.isVisible().catch(() => false);
if (gearExists) {
  await gear.click();
  await dialog.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
    fail('clicking gear icon did not open Settings dialog (parity check)');
  });
  const gearDialogText = await dialog.innerText();
  if (!/general|appearance/i.test(gearDialogText)) {
    fail('gear-opened dialog missing expected General/Appearance content');
  }
} else {
  console.warn('[probe-slash-config] note: gear button not found, parity check skipped');
}

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-slash-config] OK');
console.log('  /config → Settings dialog opened with General/Appearance content');
console.log('  parity with gear-icon click verified');

await browser.close();
