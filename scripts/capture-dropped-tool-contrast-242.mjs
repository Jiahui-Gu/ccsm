// Screenshot capture for task #242 (dropped-tool surface contrast).
// Captures the ToolBlock "(no result)" marker in BOTH light and dark themes.
//
// History (#264):
//   The original version of this script flipped `theme-light` / `theme-dark`
//   classes on <html> directly. PR #218 reviewer noticed the resulting PNGs
//   md5-matched across themes — the manual class flip was racing the App's
//   `useEffect([theme])` and getting reverted, AND the App actually toggles
//   `dark` (not `theme-dark`), so the dark-side flip was a no-op.
//   Fix: route theme switches through the new `setTheme()` helper in
//   probe-utils.mjs, which goes through the store (the App's single source
//   of truth) and double-rAF settles before screenshotting.
//
// Run: node scripts/capture-dropped-tool-contrast-242.mjs <label>
//   label = "before" or "after". Outputs four PNGs:
//     dogfood-logs/dropped-tool-contrast-242/dark-<label>.png
//     dogfood-logs/dropped-tool-contrast-242/light-<label>.png
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { setTheme } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs', 'dropped-tool-contrast-242');
fs.mkdirSync(outDir, { recursive: true });

const label = process.argv[2] || 'after';

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', AGENTORY_E2E: '1', CCSM_PROD_BUNDLE: '1' }
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });

await win.evaluate(() => {
  window.__ccsmStore.setState({
    cliStatus: { state: 'found', binaryPath: '<harness>', version: null }
  });
});

const sid = 's-dropped';
await win.evaluate((s) => {
  window.__ccsmStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [{ id: s, name: 'dropped', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
    activeId: s,
    runningSessions: {},
    messagesBySession: {
      [s]: [
        { kind: 'user', id: 'u', text: 'show dropped tool' },
        { kind: 'tool', id: 't1', name: 'Read', brief: 'src/foo.ts', expanded: false, toolUseId: 'tu1', result: '' }
      ]
    }
  });
}, sid);
await win.waitForTimeout(400);

for (const theme of ['dark', 'light']) {
  // setTheme: routes through the store (App.tsx's `useEffect([theme])` is
  // the single source of truth for class application), waits for the
  // App-applied classes/data-theme attribute to land, then double-rAF
  // settles. `verify: true` asserts the --color-bg-app CSS variable
  // actually swapped — catches the "class lands but Tailwind purged the
  // override" failure mode.
  await setTheme(win, theme, { verify: true });
  const marker = win.locator('[data-testid="tool-no-result"]').first();
  // Clip to the row containing the marker so the screenshot focuses on the
  // dropped-tool surface, not the whole window.
  const row = marker.locator('xpath=ancestor::button[1]');
  const out = path.join(outDir, `${theme}-${label}.png`);
  await row.screenshot({ path: out });
  console.log(`wrote ${out}`);
}

await app.close();
