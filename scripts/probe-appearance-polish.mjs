// E2E: appearance polish probe.
//
// Exercises the polish features without needing an API key:
//   1. Theme toggle → verify <html> class flips (dark ⇄ theme-light)
//   2. Font-size slider → verify --app-font-size CSS var updates
//   3. Sidebar drag → verify sidebarWidthPct persists across reload
//   4. Memory tab → create/edit CLAUDE.md in a temp cwd, verify file written
//
// Pure black-box where possible; uses store introspection only for the
// persist-round-trip step (which otherwise needs a full app restart to see).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-appearance-polish] FAIL: ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[probe-appearance-polish] OK: ${msg}`);
}

const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-polish-probe-'));

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' },
});

// Stub folder-picker so "Browse" returns tmpRepo.
await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, tmpRepo);

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2000);

// Open Settings via Cmd/Ctrl+,
await win.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
await win.waitForTimeout(500);

// ── 1. Theme toggle ────────────────────────────────────────────────────────
// Click "Light"
await win.getByRole('radio', { name: /^light$/i }).click();
await win.waitForTimeout(300);
let hasLight = await win.evaluate(() =>
  document.documentElement.classList.contains('theme-light')
);
if (!hasLight) fail('theme-light class not applied after clicking Light');
ok('light theme applied');

// Click "Dark"
await win.getByRole('radio', { name: /^dark$/i }).click();
await win.waitForTimeout(300);
let hasDark = await win.evaluate(() =>
  document.documentElement.classList.contains('dark') &&
  !document.documentElement.classList.contains('theme-light')
);
if (!hasDark) fail('dark class not applied / theme-light not cleared');
ok('dark theme applied');

// ── 2. Font size slider ────────────────────────────────────────────────────
const slider = win.getByRole('slider', { name: /font size/i });
await slider.focus();
// Set to 16 by pressing End
await win.keyboard.press('End');
await win.waitForTimeout(150);
const bigPx = await win.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--app-font-size').trim()
);
if (bigPx !== '16px') fail(`expected --app-font-size 16px, got "${bigPx}"`);
ok(`font-size slider → ${bigPx}`);
// Back to 14 (default)
await win.keyboard.press('Home');
await win.keyboard.press('ArrowRight');
await win.keyboard.press('ArrowRight');
await win.waitForTimeout(150);

// ── 3. Memory tab ──────────────────────────────────────────────────────────
// Close settings first; create a session pinned to tmpRepo so project memory is active.
await win.keyboard.press('Escape');
await win.waitForTimeout(200);

// Use the empty-state New Session if present, else tutorial skip → New Session.
const tutorialSkip = win.getByRole('button', { name: /skip|not now/i }).first();
if (await tutorialSkip.isVisible().catch(() => false)) {
  await tutorialSkip.click();
  await win.waitForTimeout(200);
}
const newSessionBtn = win.getByRole('button', { name: /new session/i }).first();
await newSessionBtn.click();
await win.waitForTimeout(500);

// Change cwd to tmpRepo via StatusBar cwd picker. The StatusBar "Browse"
// triggers pickDirectory (stubbed above). If this is already the default,
// we're fine either way — we only need the active session's cwd to equal
// tmpRepo so MemoryPane shows the project editor.
const cwdChip = win.locator('[data-cwd-trigger]').first();
if (await cwdChip.isVisible().catch(() => false)) {
  await cwdChip.click();
  await win.waitForTimeout(200);
  const browse = win.getByRole('menuitem', { name: /browse/i }).first();
  if (await browse.isVisible().catch(() => false)) {
    await browse.click();
    await win.waitForTimeout(400);
  }
}

// Force-set cwd via store as a fallback so this probe is robust to
// StatusBar refactors. Safe — this is a dev build; production doesn't ship
// __ccsmStore.
await win.evaluate((cwd) => {
  const w = /** @type {any} */ (window);
  if (w.__ccsmStore) w.__ccsmStore.getState().changeCwd(cwd);
}, tmpRepo);

// Re-open settings on Memory tab.
await win.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
await win.waitForTimeout(300);
await win.getByRole('button', { name: /^memory$/i }).click();
await win.waitForTimeout(400);

// Find the project editor textarea (first textarea in the MemoryPane block
// whose title reads "Project memory").
const projectBlock = win.locator('div', { hasText: /project memory/i }).first();
const projectTextarea = projectBlock.locator('textarea').first();
await projectTextarea.waitFor({ state: 'visible', timeout: 5000 });
await projectTextarea.fill('# probe\nwritten by probe-appearance-polish\n');

// Explicit Save button
await projectBlock.getByRole('button', { name: /^save$/i }).click();
await win.waitForTimeout(500);

const memoryPath = path.join(tmpRepo, 'CLAUDE.md');
if (!fs.existsSync(memoryPath)) fail(`CLAUDE.md not written at ${memoryPath}`);
const content = fs.readFileSync(memoryPath, 'utf8');
if (!content.includes('written by probe-appearance-polish')) {
  fail(`CLAUDE.md content unexpected:\n${content}`);
}
ok(`CLAUDE.md written at ${memoryPath}`);

// ── 4. Sidebar width persistence ───────────────────────────────────────────
// Close settings.
await win.keyboard.press('Escape');
await win.waitForTimeout(200);

// Programmatically set an unusual width via the store (simulating a drag
// outcome) — real drag coords are flaky in CI. This still proves the
// persist round-trip end-to-end.
const chosen = 0.34;
await win.evaluate((pct) => {
  const w = /** @type {any} */ (window);
  if (w.__ccsmStore) w.__ccsmStore.getState().setSidebarWidthPct(pct);
}, chosen);

// Wait out the 250ms persist debounce.
await win.waitForTimeout(500);

// Reload the renderer. The main process (db, IPC) keeps running.
await win.reload();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2000);

const persisted = await win.evaluate(() => {
  const w = /** @type {any} */ (window);
  return w.__ccsmStore?.getState().sidebarWidthPct ?? null;
});
if (persisted === null || Math.abs(persisted - chosen) > 0.005) {
  fail(`sidebarWidthPct did not persist: got ${persisted}, expected ${chosen}`);
}
ok(`sidebarWidthPct persisted across reload: ${persisted}`);

// ── Done ───────────────────────────────────────────────────────────────────
await app.close();
fs.rmSync(tmpRepo, { recursive: true, force: true });
console.log('\n[probe-appearance-polish] all checks passed');
process.exit(0);
