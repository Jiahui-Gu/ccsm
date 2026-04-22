// Probe: /doctor client handler.
//
// Stubs window.agentory.doctor.run to return a mixed-result bundle and
// asserts the renderer formats it as a warn-tone banner with [ok]/[fail]
// markers.
import { chromium } from 'playwright';
import { makeSlashStubInit, devServerUp } from './probe-slash-stub.mjs';

const PORT = process.env.AGENTORY_DEV_PORT ?? '4100';
const URL = `http://localhost:${PORT}/`;

if (!(await devServerUp(URL))) {
  console.log('[probe-slash-doctor] skipped: dev server not reachable at', URL);
  process.exit(0);
}

function fail(msg) {
  console.error(`\n[probe-slash-doctor] FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.addInitScript(makeSlashStubInit());

await page.goto(URL, { waitUntil: 'networkidle' });
// Override doctor.run with a mixed-result bundle.
await page.evaluate(() => {
  window.__doctorOverride = () => ({
    checks: [
      { name: 'settings.json', ok: true, detail: '/home/u/.claude/settings.json' },
      { name: 'claude binary', ok: false, detail: 'not found on PATH' },
      { name: 'data dir writable', ok: true, detail: '/data' }
    ]
  });
});

await page.getByRole('button', { name: /new session/i }).first().click();
const textarea = page.locator('textarea');
await textarea.waitFor({ state: 'visible' });
await textarea.click();
await textarea.fill('/doctor');
await page.waitForTimeout(80);
await page.keyboard.press('Escape');
await page.keyboard.press('Enter');

const banner = page.locator('[role="status"]').filter({ hasText: /Doctor:/ });
await banner.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {
  fail('/doctor did not render a banner');
});
const text = await banner.innerText();
if (!text.includes('issues found')) fail(`expected "issues found" header, got:\n${text}`);
if (!text.includes('[fail]')) fail('missing [fail] marker for failing check');
if (!text.includes('[ok]')) fail('missing [ok] marker for passing check');

console.log('[probe-slash-doctor] OK');
await browser.close();
