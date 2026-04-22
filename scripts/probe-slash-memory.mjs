// Probe: /memory client handler.
//
// Asserts the handler invokes window.agentory.memory.openUserFile and
// renders a confirmation banner.
import { chromium } from 'playwright';
import { makeSlashStubInit, devServerUp } from './probe-slash-stub.mjs';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4100';
const URL = `http://localhost:${PORT}/`;

if (!(await devServerUp(URL))) {
  console.log('[probe-slash-memory] skipped: dev server not reachable at', URL);
  process.exit(0);
}

function fail(msg) {
  console.error(`\n[probe-slash-memory] FAIL: ${msg}`);
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
await textarea.fill('/memory');
await page.waitForTimeout(80);
await page.keyboard.press('Escape');
await page.keyboard.press('Enter');

const banner = page.locator('[role="status"]').filter({ hasText: 'Opened user memory' });
await banner.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('/memory did not render the confirmation banner');
});
const calls = await page.evaluate(() => window.__memoryOpenCalls?.length ?? 0);
if (calls !== 1) fail(`expected exactly 1 openUserFile call, got ${calls}`);

console.log('[probe-slash-memory] OK');
await browser.close();
