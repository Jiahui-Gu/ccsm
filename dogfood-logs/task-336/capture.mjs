// task #336 — capture before/after screenshots of the Bash command typing
// preview in ToolBlock. Pattern mirrors dogfood-logs/task-327/capture.mjs.
// Uses a static HTML mock (mock.html) so the typing state is deterministic
// — no need to race a live claude.exe session to catch the caret in the
// half-second window before the canonical assistant tool_use lands.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockUrl = pathToFileURL(resolve(__dirname, 'mock.html')).href;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 720, height: 360 },
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
