// Verifies: app launches with no native frame on win/linux, drag regions
// exist at the top of both sidebar and right pane, the three self-drawn
// window controls live INSIDE the right pane (not a global title bar), and
// the two top strips are vertically aligned (same height, same top=0).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-titlebar] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NODE_ENV: 'development' } });
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });

const platform = await app.evaluate(() => process.platform);

// At least two drag regions should be mounted (sidebar top + right pane top).
const dragRegions = await win.evaluate(() => {
  const els = Array.from(document.querySelectorAll('[style*="app-region: drag"]'));
  return els
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { height: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
    })
    .filter((r) => r.top === 0);
});
if (dragRegions.length < 2) {
  await app.close();
  fail(`expected >=2 top drag regions, got ${dragRegions.length}: ${JSON.stringify(dragRegions)}`);
}
const EXPECTED_STRIP = 32;
for (const r of dragRegions) {
  if (Math.abs(r.height - EXPECTED_STRIP) > 2) {
    await app.close();
    fail(`drag region height expected ~${EXPECTED_STRIP}, got ${r.height}. all=${JSON.stringify(dragRegions)}`);
  }
}

// On win/linux: window controls must be inside the right pane (not the
// sidebar). We assert the Close button is to the right of the sidebar's
// right edge.
if (platform !== 'darwin') {
  for (const name of ['Minimize', 'Close']) {
    await win.locator(`button[aria-label="${name}"]`).waitFor({ state: 'visible', timeout: 5000 });
  }
  // Maximize OR Restore depending on current state.
  await win
    .locator('button[aria-label="Maximize"], button[aria-label="Restore"]')
    .first()
    .waitFor({ state: 'visible', timeout: 5000 });

  const geometry = await win.evaluate(() => {
    const sidebar = document.querySelector('aside');
    const close = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Close'
    );
    if (!sidebar || !close) return null;
    const s = sidebar.getBoundingClientRect();
    const c = close.getBoundingClientRect();
    return { sidebarRight: s.right, closeLeft: c.left, closeRight: c.right, windowWidth: window.innerWidth };
  });
  if (!geometry) {
    await app.close();
    fail('sidebar or Close button missing');
  }
  if (geometry.closeLeft < geometry.sidebarRight) {
    await app.close();
    fail(`Close button is not inside the right pane (closeLeft=${geometry.closeLeft} < sidebarRight=${geometry.sidebarRight})`);
  }
  if (geometry.windowWidth - geometry.closeRight > 4) {
    await app.close();
    fail(`Close button not flush to window right edge (gap=${geometry.windowWidth - geometry.closeRight})`);
  }
}

console.log('\n[probe-e2e-titlebar] OK');
console.log(`  platform=${platform} dragRegions=${dragRegions.length}`);
await app.close();
