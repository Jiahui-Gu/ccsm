// E2E: deleting a group via the sidebar context menu cascades its sessions,
// surfaces an undo toast, and clicking Undo restores both the group AND every
// member session in their original order with their messages intact.
//
// Covers: store.deleteGroup → GroupSnapshot → restoreGroup round-trip via UI.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, seedStore } from './probe-utils.mjs';

const PROBE = 'probe-e2e-restore-group-undo';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-restore-grp');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try { // ccsm-probe-cleanup-wrap

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');

// Two groups: keep (must survive) + doom (delete + undo). Doom holds two
// sessions whose order we'll verify after restore.
await seedStore(win, {
  groups: [
    { id: 'gKeep', name: 'Keep', collapsed: false, kind: 'normal' },
    { id: 'gDoom', name: 'DoomedGroup', collapsed: false, kind: 'normal' }
  ],
  sessions: [
    { id: 'sk1', name: 'k1', state: 'idle', cwd: '~', model: 'm', groupId: 'gKeep', agentType: 'claude-code' },
    { id: 'sd1', name: 'd1', state: 'idle', cwd: '~', model: 'm', groupId: 'gDoom', agentType: 'claude-code' },
    { id: 'sd2', name: 'd2', state: 'idle', cwd: '~', model: 'm', groupId: 'gDoom', agentType: 'claude-code' }
  ],
  activeId: 'sk1',
  focusedGroupId: null,
  messagesBySession: {
    sd1: [{ kind: 'user', id: 'u-d1', text: 'first session memory' }],
    sd2: [{ kind: 'assistant', id: 'a-d2', text: 'second session memory' }]
  },
  tutorialSeen: true
});

// Capture original session order in gDoom for later comparison.
const orderBefore = await win.evaluate(() =>
  window.__ccsmStore
    .getState()
    .sessions.filter((s) => s.groupId === 'gDoom')
    .map((s) => s.id)
);

// Right-click the doom group header.
const header = win.locator('[data-group-header-id="gDoom"]').first();
await header.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('group header gDoom never appeared');
});
await header.click({ button: 'right' });

const delMenu = win.getByRole('menuitem').filter({ hasText: /^Delete group…$/ }).first();
await delMenu.waitFor({ state: 'visible', timeout: 3000 });
await delMenu.click();

// Confirm dialog opens — click the destructive confirm button.
const confirmBtn = win.getByRole('button').filter({ hasText: /^Delete group$/ }).first();
await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
await confirmBtn.click();

// Group + sessions vanish.
await win.waitForFunction(
  () => {
    const s = window.__ccsmStore.getState();
    return !s.groups.some((g) => g.id === 'gDoom') && !s.sessions.some((x) => x.groupId === 'gDoom');
  },
  null,
  { timeout: 3000 }
).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('gDoom + member sessions did not clear after Delete group');
});

// Undo toast.
const undoBtn = win.locator('button').filter({ hasText: /^Undo$/ }).first();
await undoBtn.waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('Undo toast button never appeared after group delete');
});
await undoBtn.click();

await win.waitForFunction(
  () => !!window.__ccsmStore.getState().groups.find((g) => g.id === 'gDoom'),
  null,
  { timeout: 3000 }
).catch(async () => {
  await app.close();
  ud.cleanup();
  fail('gDoom did not return after Undo');
});

const after = await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  return {
    groupBack: !!s.groups.find((g) => g.id === 'gDoom'),
    members: s.sessions.filter((x) => x.groupId === 'gDoom').map((x) => x.id),
    msgD1: s.messagesBySession.sd1?.length ?? 0,
    msgD2: s.messagesBySession.sd2?.length ?? 0,
    runningD1: !!s.runningSessions.sd1,
    interruptedD2: !!s.interruptedSessions.sd2
  };
});

if (!after.groupBack) {
  await app.close();
  ud.cleanup();
  fail('group gDoom missing from store after Undo');
}
if (JSON.stringify(after.members) !== JSON.stringify(orderBefore)) {
  await app.close();
  ud.cleanup();
  fail(`session order changed: before=${JSON.stringify(orderBefore)} after=${JSON.stringify(after.members)}`);
}
if (after.msgD1 !== 1 || after.msgD2 !== 1) {
  await app.close();
  ud.cleanup();
  fail(`messages not restored: sd1=${after.msgD1} sd2=${after.msgD2}`);
}
if (after.runningD1 || after.interruptedD2) {
  await app.close();
  ud.cleanup();
  fail(`running/interrupted leaked back: running=${after.runningD1} interrupted=${after.interruptedD2}`);
}

console.log(`\n[${PROBE}] OK`);
console.log(`  gDoom + 2 sessions deleted via right-click → Delete group → confirm`);
console.log(`  Undo toast restored group + members in original order: ${after.members.join(', ')}`);
console.log(`  messages intact, running/interrupted correctly NOT restored`);

await app.close();
ud.cleanup();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
