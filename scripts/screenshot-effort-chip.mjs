// Screenshot capture for the unified 6-tier effort+thinking chip (PR #360).
//
// Captures three states:
//   1. closed.png  — chip default 'High' in StatusBar.
//   2. open.png    — dropdown open with 6 items (model = Opus 4.7, all enabled).
//   3. gated.png   — dropdown open with model = Sonnet (Extra high + Max disabled).
//
// HOME sanitized per project rule.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, 'docs/dogfood/effort-chip');
fs.mkdirSync(OUT, { recursive: true });

const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-chip-home-'));
const USERDATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-chip-ud-'));

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

  async function seedSession(model) {
    await win.evaluate((m) => {
      window.__ccsmStore.setState({
        groups: [{ id: 'g1', name: 'Group A', collapsed: false, kind: 'normal' }],
        sessions: [
          {
            id: 's1',
            name: 'sample-session',
            state: 'idle',
            cwd: '~/projects/sample',
            model: m,
            groupId: 'g1',
            agentType: 'claude-code',
          },
        ],
        activeId: 's1',
        messagesBySession: { s1: [] },
        tutorialSeen: true,
        models: [
          { id: 'claude-opus-4-7' },
          { id: 'claude-sonnet-4-6' },
        ],
        modelsLoaded: true,
      });
    }, model);
    await win.waitForTimeout(400);
  }

  await seedSession('claude-opus-4-7');

  const chip = win.locator('[data-testid="effort-chip"]');
  await chip.waitFor({ state: 'visible', timeout: 10_000 });

  async function clipForStatusBar(extraBelow = 0) {
    const box = await win.evaluate(() => {
      const el = document.querySelector('[data-type-scale-role="status-bar"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (!box) throw new Error('status-bar not found');
    const PAD = 12;
    return {
      x: Math.max(0, Math.round(box.x - PAD)),
      y: Math.max(0, Math.round(box.y - PAD)),
      width: Math.round(box.width + PAD * 2),
      height: Math.round(box.height + PAD * 2 + extraBelow),
    };
  }

  // 1. closed
  await win.screenshot({ path: path.join(OUT, 'closed.png'), clip: await clipForStatusBar() });

  // 2. open — Opus 4.7, all 6 items enabled
  await chip.click();
  // Wait for menu items to mount (Radix portal).
  await win
    .getByRole('menuitem', { name: /^Max\b/ })
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(200);
  // Capture the entire window so the floating dropdown is included.
  await win.screenshot({ path: path.join(OUT, 'open.png'), fullPage: false });

  // Close the dropdown before swapping models.
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);

  // 3. gated — switch to Sonnet, reopen.
  await seedSession('claude-sonnet-4-6');
  await chip.waitFor({ state: 'visible', timeout: 5000 });
  await chip.click();
  await win
    .getByRole('menuitem', { name: /^Max\b/ })
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(200);
  await win.screenshot({ path: path.join(OUT, 'gated.png'), fullPage: false });

  console.log(`[screenshot] wrote closed.png, open.png, gated.png to ${OUT}`);
} finally {
  await app.close();
  try { fs.rmSync(HOME_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(USERDATA_TMP, { recursive: true, force: true }); } catch {}
}
