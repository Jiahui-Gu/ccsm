// Dogfood screenshot probe for #225 type-scale migration.
// Captures key surfaces post-migration so they can be diffed against the
// pre-migration audit screenshots in docs/design/type-scale-audit-screenshots/.
//
// Output: dogfood-logs/type-scale-225/after-*.png
//
// Run: `node scripts/probe-dogfood-type-scale-225.mjs`
//
// NOT a regression probe — this is one-shot evidence capture. The harness-ui
// case `type-scale-snapshot` is the actual guard.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'dogfood-logs/type-scale-225');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function shoot(win, name) {
  const file = path.join(OUT_DIR, `after-${name}.png`);
  await win.screenshot({ path: file });
  console.log(`captured ${file}`);
}

const app = await electron.launch({
  args: ['.'],
  cwd: REPO_ROOT,
  env: { ...process.env, NODE_ENV: 'production', CCSM_PROD_BUNDLE: '1' }
});
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
await win.evaluate(() => {
  });
await win.waitForTimeout(300);

// Sidebar + populated chat + tool block + assistant body.
await win.evaluate(() => {
  window.__ccsmStore.setState({
    groups: [
      { id: 'g-pinned', name: 'Pinned', collapsed: false, kind: 'normal' },
      { id: 'g-recent', name: 'Recent', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 's1', name: 'session-one', state: 'idle', cwd: 'C:/projects/agentory-next', model: 'claude-opus-4', groupId: 'g-pinned', agentType: 'claude-code' },
      { id: 's2', name: 'session-two', state: 'idle', cwd: 'C:/projects/some-other-repo', model: 'claude-opus-4', groupId: 'g-recent', agentType: 'claude-code' },
      { id: 's3', name: 'session-three', state: 'running', cwd: 'C:/projects/third', model: 'claude-opus-4', groupId: 'g-recent', agentType: 'claude-code' }
    ],
    activeId: 's1',
    messagesBySession: {
      s1: [
        { kind: 'user', id: 'u1', text: 'Read this file and summarize it for me.' },
        { kind: 'tool', id: 't1', name: 'read_file', brief: 'src/components/Sidebar.tsx', expanded: false, result: 'export function Sidebar() { ... }', input: { path: 'src/components/Sidebar.tsx' } },
        { kind: 'assistant', id: 'a1', text: 'The Sidebar component renders a vertical list of groups, with each group containing draggable session rows. Selection is wired through the store and the row uses the `text-chrome` token for chrome density.' }
      ]
    }
  });
});
await win.waitForTimeout(500);
await shoot(win, 'sidebar-and-chat');

// Settings dialog open.
await win.keyboard.press('Control+,');
await win.waitForSelector('[role="dialog"]', { timeout: 5000 });
await win.waitForTimeout(300);
await shoot(win, 'settings-dialog');
await win.keyboard.press('Escape');
await win.waitForTimeout(200);

// Command palette.
await win.keyboard.press('Control+f');
await win.waitForTimeout(250);
await shoot(win, 'command-palette');
await win.keyboard.press('Escape');
await win.waitForTimeout(150);

// Empty state.
await win.evaluate(() => {
  window.__ccsmStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
    activeId: 's1',
    messagesBySession: { s1: [] }
  });
});
await win.waitForTimeout(300);
await shoot(win, 'empty-state');

// Shortcut overlay.
await win.evaluate(() => { document.body.focus(); });
await win.keyboard.press('Shift+Slash');
await win.waitForSelector('[data-shortcut-overlay]', { timeout: 3000 });
await win.waitForTimeout(250);
await shoot(win, 'shortcut-overlay');
await win.keyboard.press('Escape');
await win.waitForTimeout(150);

await app.close();
console.log(`\nDone. Screenshots in ${OUT_DIR}`);
