// task #327 — capture before/after screenshots of every MetaLabel callsite.
// Pattern borrowed from dogfood-logs/task-320/capture.mjs.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockUrl = pathToFileURL(resolve(__dirname, 'mock.html')).href;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 720, height: 720 },
  deviceScaleFactor: 2
});
const page = await context.newPage();

for (const variant of ['before', 'after']) {
  await page.goto(`${mockUrl}?variant=${variant}`);
  await page.waitForLoadState('networkidle');
  const out = resolve(__dirname, `${variant}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`wrote ${out}`);
}

await browser.close();
