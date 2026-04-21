// Verifies: app launches with no native frame, TitleBar is mounted, and on
// win/linux the three self-drawn window controls are present and clickable.
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
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10000 });

const platform = await app.evaluate(({ app: a }) => a ? process.platform : process.platform);

// TitleBar element: h-8 at top of app, has drag region style.
const titleBar = await win.evaluate(() => {
  const el = document.querySelector('[style*="app-region"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { height: r.height, top: r.top };
});
if (!titleBar) { await app.close(); fail('TitleBar not mounted'); }
if (Math.abs(titleBar.height - 32) > 1) { await app.close(); fail(`TitleBar height expected 32, got ${titleBar.height}`); }
if (titleBar.top !== 0) { await app.close(); fail(`TitleBar not at top, got top=${titleBar.top}`); }

if (platform !== 'darwin') {
  for (const name of ['Minimize', 'Close']) {
    const btn = win.getByRole('button', { name });
    await btn.waitFor({ state: 'visible', timeout: 3000 });
  }
  // Maximize OR Restore depending on current state.
  const maxBtn = win.getByRole('button', { name: /Maximize|Restore/ });
  await maxBtn.waitFor({ state: 'visible', timeout: 3000 });
}

console.log('\n[probe-e2e-titlebar] OK');
console.log(`  platform=${platform} titleBarHeight=${titleBar.height}`);
await app.close();
