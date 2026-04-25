// Screenshot capture for Task #259 — SidebarResizer migration to .pane-resize-handle.
//
// Captures three states (idle / hover / active-drag) for the CURRENT bundle.
// Run this once on the new branch (after.png set), and once after temporarily
// reverting the change in src/components/SidebarResizer.tsx and rebuilding
// (before.png set). The `--label` CLI arg picks the prefix.
//
// HOME is sanitized per project rule (~/.claude skill injection avoidance).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, 'dogfood-logs/sidebar-resizer-259');
fs.mkdirSync(OUT, { recursive: true });

const labelArg = process.argv.find((a) => a.startsWith('--label='));
const LABEL = labelArg ? labelArg.slice('--label='.length) : 'after';

const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-resizer-259-home-'));
const USERDATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-resizer-259-ud-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${USERDATA_TMP}`],
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    AGENTORY_PROD_BUNDLE: '1',
    CCSM_PROD_BUNDLE: '1',
    HOME: HOME_TMP,
    USERPROFILE: HOME_TMP,
  },
});
app.process().stdout?.on('data', (b) => process.stdout.write('[main:stdout] ' + b));
app.process().stderr?.on('data', (b) => process.stderr.write('[main:stderr] ' + b));

try {
  const win = await appWindow(app, { timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
  await win.setViewportSize({ width: 1200, height: 720 });

  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'Group A', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's1', name: 'session one', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4-7', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's1',
      messagesBySession: { s1: [] },
    });
  });
  await win.waitForTimeout(600);

  const aside = await win.evaluate(() => {
    const a = document.querySelector('aside');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!aside) throw new Error('no aside');
  const clip = {
    x: Math.max(0, Math.round(aside.x + aside.width - 30)),
    y: Math.round(aside.y),
    width: 80,
    height: Math.min(Math.round(aside.height), 600),
  };

  const sep = win.locator('[role="separator"][aria-orientation="vertical"]').first();
  const sepBox = await sep.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  console.log(`[screenshot] sep box`, sepBox, 'clip', clip);

  // Idle.
  await win.mouse.move(20, 20);
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-1-idle.png`), clip });

  // Hover (raw mouse move to avoid playwright's visibility check).
  const cx = sepBox.x + sepBox.width / 2;
  const cy = sepBox.y + sepBox.height / 2;
  await win.mouse.move(cx, cy);
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-2-hover.png`), clip });

  // Active (drag).
  await win.mouse.down();
  await win.mouse.move(cx + 4, cy);
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-3-active.png`), clip });
  await win.mouse.up();
  await win.waitForTimeout(150);

  console.log(`[screenshot] wrote ${LABEL}-{1-idle,2-hover,3-active}.png to ${OUT}`);
} finally {
  await app.close();
  try { fs.rmSync(HOME_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(USERDATA_TMP, { recursive: true, force: true }); } catch {}
}
