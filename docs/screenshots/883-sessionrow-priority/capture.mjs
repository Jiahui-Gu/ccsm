// Capture before/after screenshots for #883.
// Renders harness.html twice (with and without #after hash) and writes PNGs.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const harness = pathToFileURL(path.join(__dirname, 'harness.html')).href;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 600, height: 320 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

for (const variant of ['before', 'after']) {
  await page.goto(variant === 'after' ? `${harness}#after` : harness);
  // Pause animations at peak halo so the "before" screenshot actually shows
  // the competing glow vs the dot (rather than the 0% keyframe).
  await page.addStyleTag({ content: '*, *::before, *::after { animation-delay: -0.8s !important; animation-play-state: paused !important; }' });
  await page.waitForTimeout(50);
  const out = path.join(__dirname, `${variant}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log('wrote', out);
}

await browser.close();
