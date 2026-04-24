// E2E: deleting a single session via the sidebar context menu surfaces an
// undo toast; clicking Undo restores the row + its messages + draft.
//
// Covers: store.deleteSession → SessionSnapshot → restoreSession round-trip
// through the actual UI (right-click → Delete menu item → Undo button).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, seedStore } from './probe-utils.mjs';

const PROBE = 'probe-e2e-restore-session-undo';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-restore-sess');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');

// Seed: one normal group with two sessions, a few persisted blocks on the
// session we'll delete. The other session exists so post-delete activeId
// has a fallback target (mirrors the J5 behavior we don't want to retest).
await seedStore(win, {
  groups: [{ id: 'gA', name: 'A', collapsed: false, kind: 'normal' }],
  sessions: [
    { id: 's-keep', name: 'keep', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
    { id: 's-doom', name: 'doomed', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
  ],
  activeId: 's-doom',
  focusedGroupId: null,
  messagesBySession: {
    's-doom': [
      { kind: 'user', id: 'u1', text: 'hello from doomed' },
      { kind: 'assistant', id: 'a1', text: 'persisted reply' }
    ]
  },
  tutorialSeen: true
});

// Right-click the doomed row → Delete menu item.
const row = win.locator('li[data-session-id="s-doom"]').first();
await row.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('row s-doom never appeared');
});
await row.click({ button: 'right' });
const del = win.getByRole('menuitem').filter({ hasText: /^Delete$/ }).first();
await del.waitFor({ state: 'visible', timeout: 3000 });
await del.click();

// Wait for the row to vanish.
await win.waitForFunction(
  () => !document.querySelector('li[data-session-id="s-doom"]'),
  null,
  { timeout: 3000 }
).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('row s-doom still present after Delete click');
});

// Undo toast — find the Undo button.
const undoBtn = win.locator('button').filter({ hasText: /^Undo$/ }).first();
await undoBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('Undo toast button never appeared');
});
await undoBtn.click();

// Row should reappear; messages should still be intact in the store.
await win.waitForFunction(
  () => !!document.querySelector('li[data-session-id="s-doom"]'),
  null,
  { timeout: 3000 }
).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('row s-doom did not return after Undo');
});

const after = await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  const sess = s.sessions.find((x) => x.id === 's-doom');
  return {
    present: !!sess,
    name: sess?.name,
    msgs: s.messagesBySession['s-doom']?.length ?? 0,
    activeId: s.activeId,
    running: !!s.runningSessions['s-doom'],
    interrupted: !!s.interruptedSessions['s-doom']
  };
});

if (!after.present) {
  await app.close();
  ud.cleanup();
  fail('s-doom missing from store after Undo');
}
if (after.msgs !== 2) {
  await app.close();
  ud.cleanup();
  fail(`expected 2 restored messages, got ${after.msgs}`);
}
if (after.name !== 'doomed') {
  await app.close();
  ud.cleanup();
  fail(`expected name='doomed', got '${after.name}'`);
}
// Worker B fix #2 belt-and-braces: running/interrupted must NOT be back.
if (after.running || after.interrupted) {
  await app.close();
  ud.cleanup();
  fail(`running/interrupted leaked back into store: running=${after.running} interrupted=${after.interrupted}`);
}

console.log(`\n[${PROBE}] OK`);
console.log(`  s-doom deleted via right-click → Delete`);
console.log(`  Undo toast restored row + ${after.msgs} messages`);
console.log(`  running/interrupted correctly NOT restored`);

await app.close();
ud.cleanup();
