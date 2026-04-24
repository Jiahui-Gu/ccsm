// Screenshot capture for Task #258 — CommandPalette no-matches state (CP3)
// + bottom kbd hint row (CP4).
//
// Captures three palette states for the CURRENT bundle:
//   1. empty       — palette just opened, no query
//   2. results     — query "alpha" matches the seeded session
//   3. no-matches  — query "zzz-no-such-thing-zzz" matches nothing
//
// Run once on the new branch (after.png set), and once after stashing the
// CommandPalette change + rebuilding (before.png set). The `--label` CLI arg
// picks the prefix.
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
const OUT = path.resolve(ROOT, 'dogfood-logs/command-palette-258');
fs.mkdirSync(OUT, { recursive: true });

const labelArg = process.argv.find((a) => a.startsWith('--label='));
const LABEL = labelArg ? labelArg.slice('--label='.length) : 'after';

const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-palette-258-home-'));
const USERDATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-palette-258-ud-'));

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
      cliStatus: { state: 'found', binaryPath: '<screenshot>', version: null },
      groups: [{ id: 'g1', name: 'Group A', collapsed: false, kind: 'normal' }],
      sessions: [
        { id: 's1', name: 'Alpha session', state: 'idle', cwd: '~/alpha', model: 'claude-opus-4-7', groupId: 'g1', agentType: 'claude-code' },
        { id: 's2', name: 'Beta session',  state: 'idle', cwd: '~/beta',  model: 'claude-opus-4-7', groupId: 'g1', agentType: 'claude-code' },
      ],
      activeId: 's1',
      messagesBySession: { s1: [], s2: [] },
      tutorialSeen: true,
    });
  });
  await win.waitForTimeout(400);

  // Open the palette (Ctrl+F triggers App.tsx handler).
  await win.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true })
    );
  });
  const dialog = win.locator('[role="dialog"]').filter({ has: win.locator('input[placeholder*="Search"]') });
  await dialog.waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(300);

  async function clipFor() {
    const box = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    // 12px padding around the dialog so the drop shadow shows.
    const PAD = 16;
    return {
      x: Math.max(0, Math.round(box.x - PAD)),
      y: Math.max(0, Math.round(box.y - PAD)),
      width: Math.round(box.width + PAD * 2),
      height: Math.round(box.height + PAD * 2),
    };
  }

  const input = win.locator('input[placeholder*="Search"]');

  // 1. Empty state.
  await input.fill('');
  await win.waitForTimeout(200);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-1-empty.png`), clip: await clipFor() });

  // 2. Results state.
  await input.fill('alpha');
  await win.waitForTimeout(250);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-2-results.png`), clip: await clipFor() });

  // 3. No-matches state.
  await input.fill('zzz-no-such-thing-zzz');
  await win.waitForTimeout(250);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-3-no-matches.png`), clip: await clipFor() });

  console.log(`[screenshot] wrote ${LABEL}-{1-empty,2-results,3-no-matches}.png to ${OUT}`);
} finally {
  await app.close();
  try { fs.rmSync(HOME_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(USERDATA_TMP, { recursive: true, force: true }); } catch {}
}
