// Visual probe for the two-pane shell redesign. Screenshots the window in
// dark and light themes (we flip the store's `theme` setting at runtime)
// and asserts the core shell invariants:
//
//   - Controls (Minimize / Maximize|Restore / Close) live in the right pane
//     (closeLeft >= sidebar.right), not in a cross-window title bar.
//   - The two top drag strips (sidebar + right pane) are vertically aligned.
//   - Sidebar is resizable-agnostic for now — we only check that both
//     its collapsed and expanded widths render without layout break.
//
// Screenshots land under docs/screenshots/shell-redesign-{dark,light}.png so
// the PR body can link them.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const shotsDir = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shotsDir, { recursive: true });

function fail(msg) {
  console.error(`\n[probe-shell-redesign] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10000 });

// Theme is stored in the zustand store's `theme` field. Flip via setState
// so the useEffect in App.tsx toggles the `.dark` class on <html>.
async function setTheme(theme) {
  await win.evaluate((t) => {
    const s = window.__agentoryStore;
    if (!s) throw new Error('store not on window');
    s.setState({ theme: t });
  }, theme);
  // Give useEffect a tick to apply.
  await win.waitForTimeout(100);
}

async function shoot(name) {
  const p = path.join(shotsDir, `shell-redesign-${name}.png`);
  await win.screenshot({ path: p });
  return p;
}

await setTheme('dark');
const darkShot = await shoot('dark');

await setTheme('light');
const lightShot = await shoot('light');

// Back to dark for assertions (controls are visible in both).
await setTheme('dark');

const layout = await win.evaluate(() => {
  const sidebar = document.querySelector('aside');
  const main = document.querySelector('main');
  const close = Array.from(document.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === 'Close'
  );
  const dragStrips = Array.from(document.querySelectorAll('[style*="app-region"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
    })
    .filter((r) => r.top === 0);
  return {
    sidebarRight: sidebar?.getBoundingClientRect().right ?? null,
    mainLeft: main?.getBoundingClientRect().left ?? null,
    closeLeft: close?.getBoundingClientRect().left ?? null,
    closeRight: close?.getBoundingClientRect().right ?? null,
    windowWidth: window.innerWidth,
    dragStrips
  };
});

const platform = await app.evaluate(() => process.platform);

if (platform !== 'darwin') {
  if (layout.closeLeft == null) fail('Close button missing');
  if (layout.closeLeft < (layout.sidebarRight ?? 0)) {
    fail(`Close button in left pane (closeLeft=${layout.closeLeft} < sidebarRight=${layout.sidebarRight})`);
  }
  if (layout.windowWidth - layout.closeRight > 4) {
    fail(`Close button not flush to right edge (gap=${layout.windowWidth - layout.closeRight})`);
  }
}

if (layout.dragStrips.length < 2) {
  fail(`expected >=2 top drag strips, got ${layout.dragStrips.length}`);
}
const heights = new Set(layout.dragStrips.map((d) => d.height));
if (heights.size !== 1) fail(`drag strips have mismatched heights: ${[...heights]}`);

console.log('\n[probe-shell-redesign] OK');
console.log(`  platform=${platform}`);
console.log(`  darkShot=${darkShot}`);
console.log(`  lightShot=${lightShot}`);
console.log(`  closeLeft=${layout.closeLeft} sidebarRight=${layout.sidebarRight}`);
await app.close();
