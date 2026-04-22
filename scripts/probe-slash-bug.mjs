// Probe: /bug client handler.
//
// Asserts the handler calls window.agentory.openExternal with a github
// new-issue URL containing pre-filled environment metadata.
import { chromium } from 'playwright';
import { makeSlashStubInit, devServerUp } from './probe-slash-stub.mjs';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4100';
const URL = `http://localhost:${PORT}/`;

if (!(await devServerUp(URL))) {
  console.log('[probe-slash-bug] skipped: dev server not reachable at', URL);
  process.exit(0);
}

function fail(msg) {
  console.error(`\n[probe-slash-bug] FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(makeSlashStubInit());

await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  window.__getVersionOverride = () => '9.9.9-probe';
});

await page.getByRole('button', { name: /new session/i }).first().click();
const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible' });
await textarea.click();
await textarea.fill('/bug');
await page.waitForTimeout(80);
await page.keyboard.press('Escape');
await page.keyboard.press('Enter');

await page
  .waitForFunction(() => (window.__externalUrls?.length ?? 0) > 0, null, { timeout: 3000 })
  .catch(() => fail('/bug did not call openExternal'));

const urls = await page.evaluate(() => window.__externalUrls);
if (urls.length !== 1) fail(`expected 1 url, got ${urls.length}`);
const url = urls[0];
if (!url.includes('github.com/Jiahui-Gu/Agentory-next/issues/new')) {
  fail(`expected GitHub issue URL, got: ${url}`);
}
const decoded = decodeURIComponent(url);
if (!decoded.includes('Agentory: 9.9.9-probe')) {
  fail(`expected version in body, got: ${decoded}`);
}

const banner = page.locator('[role="status"]').filter({ hasText: 'Bug report' });
await banner.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {
  fail('/bug did not render confirmation banner');
});

console.log('[probe-slash-bug] OK');
await browser.close();
