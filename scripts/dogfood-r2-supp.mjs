// Dogfood R2 — supplementary probe for paths 1 (skeleton-evidence) and 9 (controls).
import { _electron as electron } from 'playwright';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.cwd();
const userData = path.join(repoRoot, '.dogfood-r2-userdata-supp');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
const screenshotDir = path.join(repoRoot, 'docs', 'screenshots', 'dogfood-r2');
const ccsmExe = path.join(repoRoot, 'release', 'win-unpacked', 'CCSM.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = { path1Skeleton: null, path9Controls: null };

const app = await electron.launch({
  executablePath: ccsmExe,
  args: [`--user-data-dir=${userData}`],
  env: { ...process.env, ELECTRON_DISABLE_GPU: '1' },
  timeout: 60000,
});
const win = await app.firstWindow();

// --- PATH 1 supplementary: poll for skeleton testids during early window ---
const skelObs = { sawSidebarSkel: false, sawMainSkel: false, sawNewsessionSkel: false, frames: [] };
const start = Date.now();
for (let i = 0; i < 30; i++) {
  if (Date.now() - start > 6000) break;
  const snap = await win.evaluate(() => {
    return {
      t: Date.now(),
      sidebarSkel: !!document.querySelector('[data-testid="sidebar-skeleton"]'),
      mainSkel: !!document.querySelector('[data-testid="main-skeleton"]'),
      newSessionSkel: !!document.querySelector('[data-testid="sidebar-skeleton-newsession"]'),
      rowSkelCount: document.querySelectorAll('[data-testid="sidebar-skeleton-row"]').length,
      hydrated: window.__ccsmStore?.getState?.()?.hydrated ?? null,
    };
  }).catch(() => null);
  if (snap) {
    if (snap.sidebarSkel) skelObs.sawSidebarSkel = true;
    if (snap.mainSkel) skelObs.sawMainSkel = true;
    if (snap.newSessionSkel) skelObs.sawNewsessionSkel = true;
    skelObs.frames.push(snap);
    if (snap.hydrated) break;
  }
  await sleep(150);
}
out.path1Skeleton = skelObs;
await win.screenshot({ path: path.join(screenshotDir, 'path-1-skeleton-supplementary.png') });

// --- PATH 9 supplementary: shortcut + controls ---
await sleep(2000);
try {
  await win.waitForFunction(() => !!window.__ccsmStore?.getState?.()?.hydrated, null, { timeout: 15000 });
} catch {}
await sleep(1000);

const before = await win.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  return {
    settingsBtn: buttons.some((b) => /setting/i.test(b.getAttribute('aria-label') || '') || /setting/i.test(b.title || '')),
    searchBtn: buttons.some((b) => /search/i.test(b.getAttribute('aria-label') || '')),
    newSessionBtn: buttons.some((b) => /new\s*session/i.test(b.textContent || '')),
    windowControls: !!document.querySelector('[data-testid*="window-control"], .window-controls, [class*="WindowControls"]'),
    btnCount: buttons.length,
  };
});

await win.keyboard.press('Control+f');
await sleep(800);
const palette = await win.evaluate(() => {
  return {
    dlgCount: document.querySelectorAll('[role="dialog"]').length,
    paletteEl: !!document.querySelector('[data-testid*="palette"], [data-testid*="command"], [cmdk-root]'),
    bodyHasPalette: /search|command|palette/i.test(document.body.textContent || ''),
  };
});
await win.screenshot({ path: path.join(screenshotDir, 'path-9-search-palette.png'), fullPage: true });
await win.keyboard.press('Escape');
await sleep(400);

await win.keyboard.press('Control+,');
await sleep(800);
const settings = await win.evaluate(() => {
  return {
    dlgCount: document.querySelectorAll('[role="dialog"]').length,
    settingsTextVisible: /settings|preferences|theme|language/i.test(document.body.textContent || ''),
  };
});
await win.screenshot({ path: path.join(screenshotDir, 'path-9-settings.png'), fullPage: true });
await win.keyboard.press('Escape');

out.path9Controls = { before, palette, settings };

writeFileSync(path.join(screenshotDir, 'r2-supp-summary.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await app.close();
