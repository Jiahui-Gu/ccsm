// E2E: cross-group drag & drop.
//
// Fixture: seed sessions directly into the store (window.__agentoryStore
// is exposed in dev). Seeding pre-existing sessions is equivalent to "user
// had these from prior runs" — the start point we care about is the drag
// gesture, the end point is the DOM after drop. No SDK / API key involved.
//
// What we verify:
//   1. Drag a session into a DIFFERENT (already-open) group's header → the
//      session now lives inside that group's <ul> in the DOM.
//   2. Drag a session onto a COLLAPSED group's header → after 400ms hover,
//      the group auto-expands, and on release the session lands inside it.
//
// This catches the class of bug: cross-container moves are ignored because
// the target container isn't registered as a droppable (or collapsed groups
// can't receive drops at all).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-dnd] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);

// Wipe any persisted state from the user's dev DB and seed a clean fixture:
//   Group G1 (custom, open):    s1, s2
//   Group G2 (custom, open):    s3
//   Group G3 (custom, collapsed): (empty)
// We want to:
//   - drag s1 from G1 → G2 (open→open header drop)
//   - drag s2 from G1 → G3 (open→collapsed header, triggers hover-expand)
await win.evaluate(() => {
  const store = window.__agentoryStore;
  if (!store) throw new Error('__agentoryStore not on window — dev build?');
  store.setState({
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
});
await win.waitForTimeout(300);

// Sanity: sidebar reflects fixture.
async function groupContains(groupId, sessionId) {
  return await win.evaluate(
    ({ groupId, sessionId }) => {
      const header = document.querySelector(`[data-group-header-id="${groupId}"]`);
      if (!header) return null;
      const ul = header.parentElement?.querySelector('ul[data-group-id="' + groupId + '"]');
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

if (!(await groupContains('g1', 's1'))) { await app.close(); fail('fixture: s1 not in g1'); }
if (!(await groupContains('g2', 's3'))) { await app.close(); fail('fixture: s3 not in g2'); }
if (await groupIsOpen('g3')) { await app.close(); fail('fixture: g3 should start collapsed'); }

// --- Helper: hand-driven drag via PointerSensor (activation distance = 8px).
// Playwright's mouse.down/move/up with multiple intermediate moves makes
// dnd-kit's activation constraint kick in; a single move is too fast.
async function dragTo(sourceSelector, targetSelector) {
  const src = win.locator(sourceSelector).first();
  const tgt = win.locator(targetSelector).first();
  await src.waitFor({ state: 'visible', timeout: 5000 });
  await tgt.waitFor({ state: 'visible', timeout: 5000 });
  const sb = await src.boundingBox();
  const tb = await tgt.boundingBox();
  if (!sb || !tb) throw new Error('dragTo: missing boundingBox');
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;
  await win.mouse.move(sx, sy);
  await win.mouse.down();
  // wiggle to satisfy activationConstraint.distance (8px)
  await win.mouse.move(sx + 10, sy + 10, { steps: 5 });
  await win.mouse.move(tx, ty, { steps: 15 });
  return { release: async () => { await win.mouse.up(); } };
}

// === Case 1: open → open. s1 (g1) → g2 header. ===
{
  const handle = await dragTo(
    'li[data-session-id="s1"]',
    '[data-group-header-id="g2"]'
  );
  await win.waitForTimeout(150);
  await handle.release();
  await win.waitForTimeout(300);

  if (await groupContains('g1', 's1')) { await app.close(); fail('s1 still in g1 after drag to g2 header'); }
  if (!(await groupContains('g2', 's1'))) { await app.close(); fail('s1 did not land in g2 after cross-group drag'); }
}

// === Case 2: open → collapsed. s2 (g1) → g3 header. Hover must auto-expand. ===
{
  const src = win.locator('li[data-session-id="s2"]').first();
  const tgt = win.locator('[data-group-header-id="g3"]').first();
  const sb = await src.boundingBox();
  const tb = await tgt.boundingBox();
  if (!sb || !tb) { await app.close(); fail('case2: missing boundingBox'); }
  await win.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await win.mouse.down();
  await win.mouse.move(sb.x + sb.width / 2 + 10, sb.y + sb.height / 2 + 10, { steps: 5 });
  // Hover on g3 header and HOLD >400ms so the auto-expand timer fires.
  await win.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 15 });
  await win.waitForTimeout(700);

  if (!(await groupIsOpen('g3'))) {
    await win.mouse.up();
    await app.close();
    fail('g3 did NOT auto-expand after 400ms hover');
  }

  // Still holding — now release on the (now-open) header to drop into g3.
  await win.mouse.up();
  await win.waitForTimeout(300);

  if (await groupContains('g1', 's2')) { await app.close(); fail('s2 still in g1 after drag to g3 header'); }
  if (!(await groupContains('g3', 's2'))) { await app.close(); fail('s2 did not land in g3 after hover-expand drop'); }
}

console.log('\n[probe-e2e-dnd] OK');
console.log('  s1: g1 → g2 via header drop');
console.log('  s2: g1 → g3 via collapsed-header hover-expand drop');

await app.close();
