// One-off screenshot capture for UX audit Group A (task #311).
// Boots the harness electron app with a seeded session and takes two
// region screenshots:
//   1. sidebar-bottom + InputBar bottom strip
//   2. sidebar-top + right-pane top strip
//
// Usage:
//   node scripts/capture-ux-group-a.mjs --label=before
//   node scripts/capture-ux-group-a.mjs --label=after
//
// Writes to docs/screenshots/ux-group-a-<label>-{1,2}.png.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const labelArg = process.argv.find((a) => a.startsWith('--label=')) ?? '--label=before';
const label = labelArg.slice('--label='.length);
const outDir = path.join(REPO_ROOT, 'docs/screenshots');
fs.mkdirSync(outDir, { recursive: true });

const env = {
  ...process.env,
  CCSM_E2E_HIDDEN: '1',
  CCSM_PROD_BUNDLE: '1',
  CCSM_OPEN_IN_EDITOR_NOOP: '1'
};

const app = await electron.launch({
  args: [path.join(REPO_ROOT, 'dist/electron/main.js')],
  env
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
await win.evaluate(() => {
  try { window.localStorage.removeItem('ccsm:preferences'); } catch {}
  window.__ccsmStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [
      {
        id: 's-cap-1', name: 'capture-session', state: 'idle', cwd: 'C:/x',
        model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code'
      }
    ],
    activeId: 's-cap-1',
    messagesBySession: { 's-cap-1': [] }
  });
});
await win.waitForTimeout(500);

const vp = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
const sidebarRight = await win.evaluate(() => {
  const a = document.querySelector('aside');
  return a ? a.getBoundingClientRect().right : 0;
});

// 1. Bottom strip — last 120px of window, full width across both panes.
const bottomClip = {
  x: 0,
  y: Math.max(0, vp.h - 120),
  width: vp.w,
  height: 120
};
await win.screenshot({
  path: path.join(outDir, `ux-group-a-${label}-1.png`),
  clip: bottomClip
});

// 2. Top strip — first 96px of window, full width across both panes.
const topClip = { x: 0, y: 0, width: vp.w, height: 96 };
await win.screenshot({
  path: path.join(outDir, `ux-group-a-${label}-2.png`),
  clip: topClip
});

console.log(
  `wrote docs/screenshots/ux-group-a-${label}-1.png (bottom) and -2.png (top); ` +
  `sidebarRight=${sidebarRight.toFixed(0)} vp=${vp.w}x${vp.h}`
);

await app.close();
