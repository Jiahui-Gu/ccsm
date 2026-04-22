// Probe: /status client handler.
//
// Sends `/status` and asserts a banner mentions Cwd / Model / Endpoint.
// Skips gracefully when the dev server is not reachable.
import { chromium } from 'playwright';
import { makeSlashStubInit, devServerUp } from './probe-slash-stub.mjs';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4100';
const URL = `http://localhost:${PORT}/`;

if (!(await devServerUp(URL))) {
  console.log('[probe-slash-status] skipped: dev server not reachable at', URL);
  process.exit(0);
}

function fail(msg) {
  console.error(`\n[probe-slash-status] FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(makeSlashStubInit());

await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /new session/i }).first().click();
const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible' });
await textarea.click();
await textarea.fill('/status');
await page.waitForTimeout(80);
await page.keyboard.press('Escape');
await page.keyboard.press('Enter');

const banner = page.locator('[role="status"]').filter({ hasText: 'Session status' });
await banner.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('/status did not render a "Session status" banner');
});
const text = await banner.innerText();
for (const needle of ['Cwd', 'Model', 'Endpoint']) {
  if (!text.includes(needle)) fail(`/status banner missing "${needle}":\n${text}`);
}

console.log('[probe-slash-status] OK');
await browser.close();
