// One-off visual capture for PR #584 (pre-hydrate skeleton).
//
// Drives the renderer into the pre-hydrate state by setting
// `__ccsmStore.setState({ hydrated: false })` after launch. This is far
// more deterministic than racing against the loadState IPC — the live
// React tree re-renders into the skeleton branch synchronously and we
// can screenshot at our leisure. Mirrors the technique used by the
// `startup-paints-before-hydrate` harness case for state introspection.
//
// Usage: `npm run build` first, then:
//   node scripts/screenshot-584-skeleton.mjs <after|before>
//
// `<label>` decides the output filename suffix. Run twice (once with the
// fix on disk, once with it stashed) to get docs/screenshots/pr-584/
// {after,before}.png side by side.

import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
} from './probe-utils-real-cli.mjs';

const OUT_DIR = path.resolve('docs/screenshots/pr-584');
mkdirSync(OUT_DIR, { recursive: true });

const label = process.argv[2] || 'after';

(async () => {
  const isolated = await createIsolatedClaudeDir();
  const { electronApp, win } = await launchCcsmIsolated({
    tempDir: isolated.tempDir,
  });
  try {
    await win.waitForLoadState('domcontentloaded');
    // Wait for the store to be exposed on window.
    await win.waitForFunction(
      () => !!window.__ccsmStore?.getState,
      null,
      { timeout: 10000 }
    );
    // Force the renderer into the pre-hydrate branch. Both `hydrated` and
    // `activeId` must be falsy so the `if (!active) { if (!hydrated)`
    // guard in App.tsx renders the skeleton.
    await win.evaluate(() => {
      window.__ccsmStore.setState({ hydrated: false, activeId: null });
    });
    // Sit a beat so React has flushed the skeleton frame.
    await new Promise((r) => setTimeout(r, 400));

    const out = path.join(OUT_DIR, `${label}.png`);
    await win.screenshot({ path: out, fullPage: true });
    console.log(`saved ${out}`);
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
