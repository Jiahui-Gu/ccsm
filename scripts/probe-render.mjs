import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto('http://localhost:4100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const rootHtml = await page.evaluate(() => {
  const r = document.getElementById('root');
  return r ? r.innerHTML.slice(0, 800) : '<NO #root>';
});

console.log('--- root innerHTML (first 800) ---');
console.log(rootHtml);
console.log('--- console / errors ---');
for (const l of logs) console.log(l);

await browser.close();
