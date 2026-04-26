// Screenshot capture for PR #385 (sidebar spacing).
// Writes a sidebar-only PNG (full sidebar height, sidebar-width-only) plus
// a fullwindow PNG to docs/screenshots/385-sidebar-spacing/<label>.png
// and -fullwindow.png.
//
// Usage:
//   node scripts/capture-sidebar-spacing-385.mjs --label=before
//   node scripts/capture-sidebar-spacing-385.mjs --label=after

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const labelArg = process.argv.find((a) => a.startsWith('--label=')) ?? '--label=before';
const label = labelArg.slice('--label='.length);
const outDir = path.join(REPO_ROOT, 'docs/screenshots/385-sidebar-spacing');
fs.mkdirSync(outDir, { recursive: true });

const env = {
  ...process.env,
  CCSM_E2E_HIDDEN: '1',
  CCSM_PROD_BUNDLE: '1',
  CCSM_OPEN_IN_EDITOR_NOOP: '1',
};

const app = await electron.launch({
  args: [path.join(REPO_ROOT, 'dist/electron/main.js')],
  env,
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });

await win.evaluate(() => {
  try { window.localStorage.removeItem('ccsm:preferences'); } catch {}
  window.__ccsmStore.setState({
    groups: [
      { id: 'g1', name: 'Workflows', collapsed: false, kind: 'normal' },
      { id: 'g2', name: 'Refactors', collapsed: false, kind: 'normal' },
    ],
    sessions: [
      { id: 's-cap-1', name: 'add-sidebar-tests', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
      { id: 's-cap-2', name: 'fix-spacing-bug',    state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
      { id: 's-cap-3', name: 'inputbar-rhythm',    state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g2', agentType: 'claude-code' },
    ],
    activeId: 's-cap-1',
    messagesBySession: { 's-cap-1': [], 's-cap-2': [], 's-cap-3': [] },
  });
});
await win.waitForTimeout(600);

const vp = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
const aside = await win.evaluate(() => {
  const a = document.querySelector('aside');
  if (!a) return null;
  const r = a.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right };
});
if (!aside) throw new Error('no <aside>');

// 1. Sidebar-only clip — full sidebar pane.
await win.screenshot({
  path: path.join(outDir, `${label}.png`),
  clip: {
    x: Math.max(0, Math.floor(aside.x)),
    y: Math.max(0, Math.floor(aside.y)),
    width: Math.ceil(aside.width),
    height: Math.ceil(aside.height),
  },
});

// 2. Fullwindow clip — for cross-pane archived/inputbar alignment.
await win.screenshot({
  path: path.join(outDir, `${label}-fullwindow.png`),
  clip: { x: 0, y: 0, width: vp.w, height: vp.h },
});

console.log(
  `wrote ${label}.png (${Math.ceil(aside.width)}x${Math.ceil(aside.height)}) + ` +
  `${label}-fullwindow.png (${vp.w}x${vp.h}); sidebarRight=${aside.right.toFixed(0)}`
);

await app.close();
