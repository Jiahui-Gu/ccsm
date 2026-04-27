// Screenshot capture for Task #241 — InputBar typography audit.
//
// Captures three InputBar surfaces:
//   1. attachment-chip — InputBar with one image attachment (IB2).
//   2. drop-overlay    — InputBar with the drag-over overlay visible (IB3).
//   3. rejection-x     — InputBar rejection banner with X focused (IB6).
//
// Run once on the new branch (after.png set), and once on `working` (or after
// stashing changes + rebuilding) for the before set. The `--label` CLI arg
// picks the prefix.
//
// HOME is sanitized per project rule (~/.claude skill injection avoidance).
// Default theme only — the harness theme-toggle is buggy (PR #218).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, 'dogfood-logs/inputbar-typography-241');
fs.mkdirSync(OUT, { recursive: true });

const labelArg = process.argv.find((a) => a.startsWith('--label='));
const LABEL = labelArg ? labelArg.slice('--label='.length) : 'after';

const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inputbar-241-home-'));
const USERDATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inputbar-241-ud-'));

// 1x1 red PNG, base64.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

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
      sessions: [
        { id: 's1', name: 'sample-session', state: 'idle', cwd: '~/projects/sample', model: 'claude-opus-4-7', groupId: 'g1', agentType: 'claude-code' },
      ],
      activeId: 's1',
      messagesBySession: { s1: [] },
      tutorialSeen: true,
    });
  });
  await win.waitForTimeout(400);

  const inputBar = win.locator('div.relative.px-3.pt-2.pb-3').first();
  await inputBar.waitFor({ state: 'visible', timeout: 5000 });

  async function clipFor() {
    const box = await inputBar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const PAD = 12;
    return {
      x: Math.max(0, Math.round(box.x - PAD)),
      y: Math.max(0, Math.round(box.y - PAD)),
      width: Math.round(box.width + PAD * 2),
      height: Math.round(box.height + PAD * 2),
    };
  }

  // 1. Attachment chip — drop a synthesized PNG so a chip renders.
  await win.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'screenshot-sample.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    window.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  }, PNG_1X1_BASE64);
  await win.locator('text=screenshot-sample.png').first().waitFor({ state: 'visible', timeout: 5000 });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-1-attachment-chip.png`), clip: await clipFor() });

  // 2. Drop overlay — fire dragenter+dragover (no drop) to keep overlay visible.
  await win.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'pending.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    window.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
  }, PNG_1X1_BASE64);
  // Wait for overlay's dropImageHint copy to be visible.
  await win.locator('text=/drop image|drop|image/i').first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-2-drop-overlay.png`), clip: await clipFor() });

  // Cancel the drag so subsequent steps render cleanly.
  await win.evaluate(() => {
    const dt = new DataTransfer();
    window.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: dt }));
  });
  await win.waitForTimeout(200);

  // 3. Rejection banner with X focused — synthesize a too-large file via store.
  // Rather than reach into intake, dispatch a drop with a file that exceeds
  // an unsupported MIME so the rejection path runs.
  await win.evaluate(async () => {
    // Build a fake "txt" file — unsupported type → rejected by intakeFiles.
    const file = new File(['hello'], 'not-an-image.txt', { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    window.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  });
  // Wait for the rejection banner.
  const banner = win.locator('[role="alert"]').first();
  await banner.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  // Focus the X button so the focus ring renders.
  const dismiss = banner.locator('button[aria-label]').first();
  await dismiss.focus().catch(() => {});
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(OUT, `${LABEL}-3-rejection-x-focus.png`), clip: await clipFor() });

  console.log(`[screenshot] wrote ${LABEL}-{1-attachment-chip,2-drop-overlay,3-rejection-x-focus}.png to ${OUT}`);
} finally {
  await app.close();
  try { fs.rmSync(HOME_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(USERDATA_TMP, { recursive: true, force: true }); } catch {}
}
