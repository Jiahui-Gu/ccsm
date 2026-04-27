// Screenshot capture for Task #321 — "Allow always" permission prompt copy.
//
// Captures the PermissionPromptBlock with the three-button row visible
// (Reject / Allow always / Allow). Run once on `working` (label=before),
// once on this branch (label=after) — the diff highlights how the
// ambiguous "Allow always" string was replaced with the scope-explicit
// "Always allow Bash this session".
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
const OUT = path.resolve(ROOT, 'dogfood-logs/perm-allow-always-scope-321');
fs.mkdirSync(OUT, { recursive: true });

const labelArg = process.argv.find((a) => a.startsWith('--label='));
const LABEL = labelArg ? labelArg.slice('--label='.length) : 'after';

const HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-321-home-'));
const USERDATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-321-ud-'));

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

  // Seed a session + inject a representative Bash permission request so all
  // three buttons render together. Using `rm -rf` makes the misleading-copy
  // story obvious in the screenshot — old "Allow always" reads like
  // "always allow this exact destructive command".
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'Group A', collapsed: false, kind: 'normal' }],
      sessions: [
        {
          id: 's1',
          name: 'sample-session',
          state: 'idle',
          cwd: '~/projects/sample',
          model: 'claude-opus-4-7',
          groupId: 'g1',
          agentType: 'claude-code',
        },
      ],
      activeId: 's1',
      messagesBySession: { s1: [] },
      tutorialSeen: true,
    });
    const s = window.__ccsmStore.getState();
    s.appendBlocks('s1', [
      {
        kind: 'waiting',
        id: 'wait-321',
        prompt: 'Bash: rm -rf /tmp/build-cache',
        intent: 'permission',
        requestId: 'PROBE-321',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/build-cache', description: 'clear build cache' },
      },
    ]);
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 5000 });
  // Let any focus / animation settle so the focus ring appears in the shot.
  await win.waitForTimeout(450);

  // Tight clip around the alertdialog so the screenshot is reviewable diff.
  const alertdialog = win.locator('[role="alertdialog"]').first();
  const box = await alertdialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const PAD = 16;
  const clip = {
    x: Math.max(0, Math.round(box.x - PAD)),
    y: Math.max(0, Math.round(box.y - PAD)),
    width: Math.round(box.width + PAD * 2),
    height: Math.round(box.height + PAD * 2),
  };

  await win.screenshot({ path: path.join(OUT, `${LABEL}-1-allow-always-buttons.png`), clip });

  // Hover on the allow-always button to surface the new title-attribute
  // tooltip in the second shot (a no-op visually on the BEFORE branch — the
  // pre-fix code had no tooltip — which itself is part of the story).
  const btn = win.locator('[data-perm-action="allow-always"]').first();
  await btn.hover();
  await win.waitForTimeout(900); // let the OS tooltip materialize
  await win.screenshot({ path: path.join(OUT, `${LABEL}-2-allow-always-hover.png`), clip });

  console.log(
    `[screenshot] wrote ${LABEL}-{1-allow-always-buttons,2-allow-always-hover}.png to ${OUT}`,
  );
} finally {
  await app.close();
  try { fs.rmSync(HOME_TMP, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(USERDATA_TMP, { recursive: true, force: true }); } catch {}
}
