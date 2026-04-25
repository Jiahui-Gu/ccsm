// E2E: per-group + button creates a session in THAT group and selects it.
//
// Each normal-kind group's header has a small Plus IconButton on the right
// (added in commit dac3f43 / `feat(sidebar): per-group + button + reorder
// context menu`). Click should:
//   1. Create a new Session whose `groupId` equals the clicked group's id —
//      not whatever the focused/active group is.
//   2. Select the newly-created session (so the chat pane swaps to it).
//   3. NOT collapse/expand the group it lives in.
//   4. Be hidden on special groups (archive/deleted) — verified for archive.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, seedStore } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-group-add] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-group-add');
console.log(`[probe-e2e-group-add] userData = ${ud.dir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap
const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});
await win.waitForLoadState('domcontentloaded');

await seedStore(win, {
  groups: [
    { id: 'g1', name: 'Alpha', collapsed: false, kind: 'normal' },
    { id: 'g2', name: 'Bravo', collapsed: false, kind: 'normal' },
    { id: 'gA', name: 'Archived', collapsed: false, kind: 'archive' }
  ],
  sessions: [
    { id: 's1', name: 'a-only', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }
  ],
  // Active session lives in g1; we click the +button on g2 and assert the
  // new session goes to g2 anyway, NOT to the focused/active group.
  activeId: 's1',
  focusedGroupId: 'g1'
});

async function bail(msg) {
  console.error('--- pageerrors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  ud.cleanup();
  fail(msg);
}

// === Case 1: clicking g2's + creates a session in g2 (not in g1). ===
const before = await win.evaluate(() => window.__ccsmStore.getState().sessions.map((s) => ({ id: s.id, groupId: s.groupId })));
const g2Plus = win.locator('[data-group-header-id="g2"] button[aria-label*="new session" i], [data-group-header-id="g2"] button[aria-label*="新建" i]').first();
await g2Plus.waitFor({ state: 'visible', timeout: 3000 });
await g2Plus.click();
await win.waitForTimeout(300);
const after = await win.evaluate(() => window.__ccsmStore.getState().sessions.map((s) => ({ id: s.id, groupId: s.groupId })));
const beforeIds = new Set(before.map((s) => s.id));
const fresh = after.filter((s) => !beforeIds.has(s.id));
if (fresh.length !== 1) await bail(`expected exactly 1 new session, got ${fresh.length}`);
if (fresh[0].groupId !== 'g2') await bail(`new session should land in g2, got ${fresh[0].groupId}`);

// === Case 2: the new session is now active. ===
const activeId = await win.evaluate(() => window.__ccsmStore.getState().activeId);
if (activeId !== fresh[0].id) await bail(`new session should be active; activeId=${activeId}, fresh.id=${fresh[0].id}`);

// === Case 3: g2 stays expanded (the + click must not toggle collapse). ===
const g2Open = await win.evaluate(() => {
  const header = document.querySelector('[data-group-header-id="g2"]');
  return header?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true';
});
if (!g2Open) await bail('g2 collapsed after + click — the click should not propagate to header toggle');

// === Case 4: archived group has no + button. ===
const archivedPlus = await win.locator('[data-group-header-id="gA"] button[aria-label*="new session" i]').count();
if (archivedPlus !== 0) await bail(`archived group should not have a + button (got ${archivedPlus})`);

console.log('\n[probe-e2e-group-add] OK');
console.log(`  + on g2 created session ${fresh[0].id} in g2 (not g1) and made it active`);
console.log('  click did not collapse g2');
console.log('  archived group has no + button');

await app.close();
ud.cleanup();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
