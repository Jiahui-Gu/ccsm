// E2E: cross-group drag & drop, plus drag-handle vs inline-rename coexistence.
//
// Fixture: seed sessions directly into the store (window.__ccsmStore
// is exposed on window). Seeding pre-existing sessions is equivalent to "user
// had these from prior runs" — the start point we care about is the drag
// gesture, the end point is the DOM after drop. No SDK / API key involved.
//
// What we verify:
//   1. Drag a session into a DIFFERENT (already-open) group's header → the
//      session now lives inside that group's <ul> in the DOM.
//   2. Drag a session onto a COLLAPSED group's header → after 400ms hover,
//      the group auto-expands, and on release the session lands inside it.
//   3. With a session row in inline-rename mode, the rename input must
//      remain interactive (typing reaches the input) — i.e. dnd-kit's
//      pointer listeners on the row don't swallow the rename input's
//      focus/keystrokes.
//
// IMPORTANT: dnd-kit's PointerSensor listens for native PointerEvents.
// Playwright's `mouse.down/move/up` API dispatches MouseEvents, which
// Chromium does not synthesize PointerEvents from in a way the sensor
// picks up. We use the dndDrag helper which dispatches real
// PointerEvents on document — this is what makes the drag actually move.
//
// This catches the class of bug: cross-container moves are ignored because
// the target container isn't registered as a droppable (or collapsed groups
// can't receive drops at all), AND the class of bug: rename UI breaks
// because the dragHandle on the row eats input events.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, dndDrag, isolatedUserData, seedStore } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-dnd] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-dnd');
console.log(`[probe-e2e-dnd] userData = ${ud.dir}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, CCSM_PROD_BUNDLE: '1' }
});

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');

// Wipe any persisted state from the user's dev DB and seed a clean fixture:
//   Group G1 (custom, open):    s1, s2
//   Group G2 (custom, open):    s3
//   Group G3 (custom, collapsed): (empty)
// We want to:
//   - drag s1 from G1 → G2 (open→open header drop)
//   - drag s2 from G1 → G3 (open→collapsed header, triggers hover-expand)
await seedStore(win, {
  groups: [
    { id: 'g1', name: 'G1', collapsed: false, kind: 'normal' },
    { id: 'g2', name: 'G2', collapsed: false, kind: 'normal' },
    { id: 'g3', name: 'G3', collapsed: true, kind: 'normal' }
  ],
  sessions: [
    { id: 's1', name: 'session one',   state: 'waiting', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
    { id: 's2', name: 'session two',   state: 'waiting', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
    { id: 's3', name: 'session three', state: 'waiting', cwd: '~', model: 'claude-opus-4', groupId: 'g2', agentType: 'claude-code' }
  ],
  activeId: 's1'
});

async function groupContains(groupId, sessionId) {
  return await win.evaluate(
    ({ groupId, sessionId }) => {
      const ul = document.querySelector(`ul[data-group-id="${groupId}"]`);
      if (!ul) return null;
      return !!ul.querySelector(`li[data-session-id="${sessionId}"]`);
    },
    { groupId, sessionId }
  );
}
async function groupIsOpen(groupId) {
  return await win.evaluate((gid) => {
    const header = document.querySelector(`[data-group-header-id="${gid}"]`);
    if (!header) return null;
    const btn = header.querySelector('button[aria-expanded]');
    return btn?.getAttribute('aria-expanded') === 'true';
  }, groupId);
}

async function bail(msg) {
  await app.close();
  ud.cleanup();
  fail(msg);
}

if (!(await groupContains('g1', 's1'))) await bail('fixture: s1 not in g1');
if (!(await groupContains('g2', 's3'))) await bail('fixture: s3 not in g2');
if (await groupIsOpen('g3')) await bail('fixture: g3 should start collapsed');

// === Case 1: open → open. s1 (g1) → g2 header. ===
await dndDrag(
  win,
  'li[data-session-id="s1"]',
  '[data-group-header-id="g2"]'
);
if (await groupContains('g1', 's1')) await bail('s1 still in g1 after drag to g2 header');
if (!(await groupContains('g2', 's1'))) await bail('s1 did not land in g2 after cross-group drag');

// === Case 2: open → collapsed. s2 (g1) → g3 header. Hover must auto-expand. ===
await dndDrag(
  win,
  'li[data-session-id="s2"]',
  '[data-group-header-id="g3"]',
  { holdMs: 700 }
);
if (!(await groupIsOpen('g3'))) await bail('g3 did NOT auto-expand after 400ms hover');
if (await groupContains('g1', 's2')) await bail('s2 still in g1 after drag to g3 header');
if (!(await groupContains('g3', 's2'))) await bail('s2 did not land in g3 after hover-expand drop');

// === Case 3: dragHandle vs inline rename coexistence. ===
// The whole <li> is the dnd dragHandle (useSortable spreads {...listeners}
// on the row). When the user enters rename mode, the inline <input> sits
// INSIDE that li — typing must still reach the input despite the listeners.
// Right-click the row → "Rename", type a new name, press Enter, verify the
// store reflects the new name (not "swallowed" by the drag handle).
await win.locator('li[data-session-id="s3"]').click();
await win.locator('li[data-session-id="s3"]').click({ button: 'right' });
const renameItem = win.getByRole('menuitem', { name: /rename/i }).first();
await renameItem.waitFor({ state: 'visible', timeout: 3000 });
await renameItem.click();
const renameInput = win.locator('li[data-session-id="s3"] input').first();
await renameInput.waitFor({ state: 'visible', timeout: 3000 });
// Clear via select-all + type.
await renameInput.fill('renamed via probe');
await renameInput.press('Enter');
await win.waitForTimeout(300);
const after = await win.evaluate(() => {
  const s = window.__ccsmStore.getState().sessions.find((x) => x.id === 's3');
  return s ? s.name : null;
});
if (after !== 'renamed via probe') {
  await bail(`rename did not commit; expected "renamed via probe", got "${after}"`);
}

console.log('\n[probe-e2e-dnd] OK');
console.log('  s1: g1 → g2 via header drop');
console.log('  s2: g1 → g3 via collapsed-header hover-expand drop');
console.log('  s3: inline rename works while dragHandle listeners are bound');

await app.close();
ud.cleanup();
