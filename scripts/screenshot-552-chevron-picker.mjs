// One-off visual capture for PR #552 (chevron + popover cwd picker).
// Outputs into docs/screenshots/pr-552-chevron-picker/.
//
// Captures four states:
//   1. baseline-sidebar-idle.png   — sidebar with chevron clusters at rest
//   2. top-chevron-popover-open.png — top "▾" clicked, popover open with recents
//   3. group-chevron-popover-open.png — group "▾" popover anchored to a group row
//   4. mutex-only-one-open.png     — proves group popover replaced the top one
//
// Usage: `npm run build` first, then:
//   node scripts/screenshot-552-chevron-picker.mjs

import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_DIR = path.resolve('docs/screenshots/pr-552-chevron-picker');
mkdirSync(OUT_DIR, { recursive: true });

async function snap(win, name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await win.screenshot({ path: p, fullPage: true });
  console.log(`  saved ${p}`);
}

async function seedRecent(win, p) {
  await win.evaluate(async (path_) => {
    const api = window.ccsm;
    if (api?.userCwds?.push) await api.userCwds.push(path_);
    const list = await api.userCwds.get();
    const head = Array.isArray(list) && list.length > 0 ? list[0] : null;
    if (head) window.__ccsmStore.setState({ lastUsedCwd: head });
  }, p);
}

(async () => {
  const isolated = await createIsolatedClaudeDir();
  const { electronApp, win } = await launchCcsmIsolated({ tempDir: isolated.tempDir });
  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );
    await win.evaluate(() => window.__ccsmStore.setState({ tutorialSeen: true }));
    await win.waitForSelector('[data-testid="sidebar-newsession-row"]', { timeout: 10000 });

    // Seed a few recent cwds so the popover has visible rows.
    for (const sub of ['projects/ccsm', 'projects/web-app', 'work/scratch']) {
      await seedRecent(win, path.join(isolated.tempDir, sub).replace(/\\/g, '/'));
    }
    // Create a normal group so the per-group cluster renders.
    const groupId = await win.evaluate(() => {
      const st = window.__ccsmStore.getState();
      const id = st.createGroup('Demo group');
      st.focusGroup(id);
      return id;
    });
    await win.waitForFunction(
      (gid) => !!document.querySelector(`[data-group-header-id="${gid}"]`),
      groupId,
      { timeout: 4000 },
    );
    await sleep(400);

    console.log('1/4 baseline');
    await snap(win, 'baseline-sidebar-idle');

    console.log('2/4 top chevron popover');
    await win.click('[data-testid="sidebar-newsession-cwd-chevron"]');
    await win.waitForSelector('[data-testid="cwd-popover-panel"]', { timeout: 4000 });
    await sleep(300); // animation settle
    await snap(win, 'top-chevron-popover-open');

    console.log('3/4 group chevron popover (top closes)');
    await win.evaluate((gid) => {
      const c = document.querySelector(
        `[data-group-header-id="${gid}"] [data-testid="sidebar-group-newsession-cwd-chevron"]`,
      );
      c.click();
    }, groupId);
    await sleep(300);
    await snap(win, 'group-chevron-popover-open');

    console.log('4/4 mutex proof — exactly one panel');
    const panelCount = await win.evaluate(
      () => document.querySelectorAll('[data-testid="cwd-popover-panel"]').length,
    );
    console.log(`  panel count: ${panelCount} (expected 1)`);
    await snap(win, 'mutex-only-one-open');

    // Close popover before exit.
    await win.keyboard.press('Escape');
  } finally {
    try { await electronApp.close(); } catch (_) {}
    try { isolated.cleanup?.(); } catch (_) {}
  }
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
