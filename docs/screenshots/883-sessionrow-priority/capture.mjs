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
  // Use a cache-busting query param so the navigation is a real reload (not
  // an in-document hash change), guaranteeing the inline <script> re-runs.
  const url = `${harness}?v=${variant}${variant === 'after' ? '#after' : ''}`;
  await page.goto(url, { waitUntil: 'load' });

  // Let the halo keyframe actually paint at least one frame before we freeze
  // it. Without this, animation-play-state: paused can latch at the 0%
  // keyframe (box-shadow alpha 0) and the "before" PNG ends up identical to
  // the "after" PNG (both show no halo).
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  // Seek every running animation to peak halo (50% of the 1.6s loop = 0.8s)
  // and then pause. Using the Web Animations API directly is more reliable
  // than relying on negative animation-delay + paused via CSS.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      for (const anim of el.getAnimations({ subtree: false })) {
        try {
          anim.currentTime = 800; // ms — peak of the 1.6s halo keyframe
          anim.pause();
        } catch {
          /* ignore animations that don't support seek */
        }
      }
    }
  });

  // One more frame so the paused/seeked state is composited before capture.
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  const out = path.join(__dirname, `${variant}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log('wrote', out);
}

await browser.close();
