// One-off visual capture for PR #512 (sidebar top padding).
//
// Captures the sidebar top region (New Session row + Search box + first
// few sessions) with a deterministic window size so before/after PNGs
// align pixel-for-pixel.
//
// Usage:
//   npm run build
//   node scripts/screenshot-512-sidebar.mjs <after|before>
//
// Run twice — once with the pt-4 fix on disk (after) and once with it
// reverted to pt-1 (before) — to populate docs/screenshots/512-padding-tray/.

import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
} from './probe-utils-real-cli.mjs';

const OUT_DIR = path.resolve('docs/screenshots/512-padding-tray');
mkdirSync(OUT_DIR, { recursive: true });

const label = process.argv[2] || 'after';

(async () => {
  const isolated = await createIsolatedClaudeDir();
  const { electronApp, win } = await launchCcsmIsolated({
    tempDir: isolated.tempDir,
  });
  try {
    await win.waitForLoadState('domcontentloaded');
    // launchCcsmIsolated already sleeps 2.5s after DCL but the renderer
    // can take longer in cold-start. Try store first, fall back to selector.
    try {
      await win.waitForFunction(
        () => !!window.__ccsmStore?.getState,
        null,
        { timeout: 30000 }
      );
    } catch {
      console.warn('warn: __ccsmStore never appeared, continuing on selector wait');
    }
    // Wait for the sidebar New Session row to be present.
    await win.waitForSelector('[data-testid="sidebar-newsession-row"]', {
      timeout: 30000,
    });
    // Allow the React tree to settle.
    await new Promise((r) => setTimeout(r, 800));

    // Full-window screenshot for full context.
    const fullOut = path.join(OUT_DIR, `${label}-padding-full.png`);
    await win.screenshot({ path: fullOut });
    console.log(`saved ${fullOut}`);

    // Crop to sidebar top region for a focused before/after.
    const row = await win.$('[data-testid="sidebar-newsession-row"]');
    if (row) {
      const box = await row.boundingBox();
      if (box) {
        // Capture from y=0 (top of window incl. drag strip) down through
        // the row + a generous chunk below so the search box + any sessions
        // are visible. Width covers full sidebar (assume <= 320px).
        const clip = {
          x: 0,
          y: 0,
          width: Math.max(320, box.x + box.width + 16),
          height: Math.min(360, box.y + box.height + 280),
        };
        const cropOut = path.join(OUT_DIR, `${label}-padding.png`);
        await win.screenshot({ path: cropOut, clip });
        console.log(`saved ${cropOut} clip=${JSON.stringify(clip)}`);
      }
    }
  } finally {
    try {
      await electronApp.close();
    } catch {
      /* ignore */
    }
    try {
      isolated.cleanup?.();
    } catch {
      /* ignore */
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
