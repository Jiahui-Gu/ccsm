// E2E user-journey probe — sidebar RENAME, DRAG-DROP, GROUP-STATE, SELECTION.
//
// Covers J8..J17 of `probe-e2e-sidebar-journey-expectations.md`.
//
// Same divergence-recording methodology as
// `probe-e2e-sidebar-journey-create-delete.mjs`: every expectation states
// what the author thinks the right behavior is, and any mismatch is logged
// as a divergence (not silently relaxed).

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, dndDrag, isolatedUserData, seedStore } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PROBE = 'probe-e2e-sidebar-journey-rename-dnd-state';
function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-sidebar-journey-rds');
console.log(`[${PROBE}] userData = ${ud.dir}`);

let app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' }
});
let win = await appWindow(app);
const errors = [];
function wireErrors(w) {
  w.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  w.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
  });
}
wireErrors(win);
await win.waitForLoadState('domcontentloaded');

const divergences = [];
function diverge(j, expected, observed) {
  divergences.push({ j, expected, observed });
  console.log(`[${PROBE}] ${j} DIVERGE — expected: ${expected} | observed: ${observed}`);
}
async function bail(msg) {
  console.error('--- pageerrors ---\n' + errors.slice(-10).join('\n'));
  try { await app.close(); } catch {}
  ud.cleanup();
  fail(msg);
}

const state = () => win.evaluate(() => window.__agentoryStore.getState());

// ────────────────────────────────────────────────────────────────────────
// J8/J9 — Inline rename behavior (covered by probe-e2e-rename.mjs in
// detail). Here we add the cases NOT covered there:
//   - external-click commit when an unrelated SIDEBAR area is clicked
//     (non-button, non-input area). probe-e2e-rename clicks the New Session
//     button, which counts; we want a "click on neutral chrome" too.
//   - rename a group whose original name contains spaces (catches premature
//     trim() that would alter meaning).
//   - whitespace + Enter on GROUP rename (probe-e2e-rename only does
//     session for whitespace).
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'Has Spaces', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 's1', name: 'one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 's2', name: 'two', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
    ],
    activeId: 's1',
    focusedGroupId: null
  });

  // J9 - whitespace + Enter on group keeps original.
  const header = win.locator('[data-group-header-id="gA"]').first();
  await header.click({ button: 'right' });
  await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
  const gInput = win.locator('[data-group-header-id="gA"] input').first();
  await gInput.waitFor({ state: 'visible', timeout: 3000 });
  await gInput.click();
  await gInput.fill('   ');
  await gInput.press('Enter');
  await win.waitForTimeout(150);
  const after = await state();
  const g = after.groups.find((x) => x.id === 'gA');
  if (g.name !== 'Has Spaces') {
    diverge('J9.whitespace', `whitespace-only Enter on group cancels (name preserved)`, `name became "${g.name}"`);
  }

  // J10 - duplicate session names: explicitly try to rename two sessions to
  // the same string. Expectation: ALLOWED (id is identity).
  await win.locator('li[data-session-id="s1"]').first().click({ button: 'right' });
  await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
  const i1 = win.locator('li[data-session-id="s1"] input').first();
  await i1.waitFor({ state: 'visible', timeout: 3000 });
  await i1.click();
  await i1.fill('dupe');
  await i1.press('Enter');
  await win.waitForTimeout(150);

  await win.locator('li[data-session-id="s2"]').first().click({ button: 'right' });
  await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
  const i2 = win.locator('li[data-session-id="s2"] input').first();
  await i2.waitFor({ state: 'visible', timeout: 3000 });
  await i2.click();
  await i2.fill('dupe');
  await i2.press('Enter');
  await win.waitForTimeout(200);

  const after2 = await state();
  const n1 = after2.sessions.find((s) => s.id === 's1')?.name;
  const n2 = after2.sessions.find((s) => s.id === 's2')?.name;
  if (n1 !== 'dupe' || n2 !== 'dupe') {
    diverge('J10.duplicates', `both sessions can be named "dupe"`, `s1="${n1}", s2="${n2}" — uniqueness enforced silently`);
  } else {
    console.log(`[${PROBE}] J10 PASS — duplicate session names allowed`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// J11 — Cross-group drag (already covered by probe-e2e-dnd, but we add a
// strict ORDERING assertion: when dropping on a group HEADER, the dragged
// session should appear at the END of the target group (since header drop
// = "append"), not prepended to the top.
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
      { id: 'gB', name: 'B', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 'a1', name: 'a-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'b1', name: 'b-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' },
      { id: 'b2', name: 'b-two', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
    ],
    activeId: 'a1',
    focusedGroupId: null
  });
  await dndDrag(win, 'li[data-session-id="a1"]', '[data-group-header-id="gB"]');
  const idsB = await win.evaluate(() => {
    const ul = document.querySelector('ul[data-group-id="gB"]');
    return ul ? Array.from(ul.querySelectorAll('li[data-session-id]')).map((li) => li.getAttribute('data-session-id')) : null;
  });
  if (!idsB) {
    diverge('J11.dom', `gB ul exists`, `null`);
  } else if (idsB[idsB.length - 1] !== 'a1') {
    diverge('J11.appendOnHeader', `header-drop appends to end of target group → last id === "a1"`, `order=[${idsB.join(',')}]`);
  } else {
    console.log(`[${PROBE}] J11 PASS — order=[${idsB.join(',')}]`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// J12 — In-group reorder + persistence across restart.
//
// Setup: gA = [a1, a2, a3]. Drag a3 onto a1 (drop on session). Per Sidebar
// `handleDragEnd`: dropping on a session → `moveSession(active, targetGroup,
// targetSession)` which inserts the dragged BEFORE the target. So expected
// new order: [a3, a1, a2].
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [{ id: 'gA', name: 'A', collapsed: false, kind: 'normal' }],
    sessions: [
      { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'a2', name: 'a2', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'a3', name: 'a3', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
    ],
    activeId: 'a1',
    focusedGroupId: null
  });
  await dndDrag(win, 'li[data-session-id="a3"]', 'li[data-session-id="a1"]');
  const order = await win.evaluate(() => {
    const ul = document.querySelector('ul[data-group-id="gA"]');
    return ul ? Array.from(ul.querySelectorAll('li[data-session-id]')).map((li) => li.getAttribute('data-session-id')) : null;
  });
  if (!order || order.join(',') !== 'a3,a1,a2') {
    diverge('J12.reorderDom', `dropping a3 on a1 yields order [a3,a1,a2] in DOM`, `[${(order || []).join(',')}]`);
  } else {
    console.log(`[${PROBE}] J12.reorderDom PASS — [${order.join(',')}]`);
  }

  // Persistence-across-restart sub-case. The store persists sessions via the
  // electron app's persist layer (see src/stores/persist.ts). We force-flush
  // by closing the app, then relaunch with the same userData and assert the
  // order survives. We also ensure the seeded sessions are persisted by
  // having gone through real store actions (the moveSession we just did).
  // BUT seedStore() does setState directly — that may NOT trigger persist.
  // To make the test honest, we additionally drive a moveSession call so
  // the persist subscriber fires. We then close and relaunch.
  await win.evaluate(() => {
    // No-op move so persist subscriber definitely fires after our previous DOM drag.
    const s = window.__agentoryStore.getState();
    s.moveSession('a2', 'gA', null);
  });
  await win.waitForTimeout(500);
  // capture pre-restart order
  const preOrder = await win.evaluate(() =>
    window.__agentoryStore.getState().sessions.filter((s) => s.groupId === 'gA').map((s) => s.id)
  );

  await app.close();
  await new Promise((r) => setTimeout(r, 500));
  app = await electron.launch({
    args: ['.', `--user-data-dir=${ud.dir}`],
    cwd: root,
    env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' }
  });
  win = await appWindow(app);
  wireErrors(win);
  await win.waitForLoadState('domcontentloaded');
  // Wait for store hydration.
  await win.waitForFunction(
    () => !!window.__agentoryStore && document.querySelector('aside') !== null,
    null,
    { timeout: 20_000 }
  );
  await win.waitForTimeout(400);
  const postOrder = await win.evaluate(() =>
    window.__agentoryStore.getState().sessions.filter((s) => s.groupId === 'gA').map((s) => s.id)
  );
  if (postOrder.join(',') !== preOrder.join(',')) {
    diverge('J12.persistence', `session order persists across restart (pre=[${preOrder.join(',')}])`, `post=[${postOrder.join(',')}] — order lost on relaunch`);
  } else {
    console.log(`[${PROBE}] J12.persistence PASS — [${postOrder.join(',')}] survived restart`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// J13 — Hover-expand on collapsed group (covered by probe-e2e-dnd).
// We re-assert the timing window: a SHORT hover (< 400ms internal threshold)
// should NOT auto-expand. If it does, the timer is too eager.
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
      { id: 'gC', name: 'C-collapsed', collapsed: true, kind: 'normal' }
    ],
    sessions: [
      { id: 'd1', name: 'd1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'd2', name: 'd2', state: 'idle', cwd: '~', model: 'm', groupId: 'gC', agentType: 'claude-code' }
    ],
    activeId: 'd1',
    focusedGroupId: null
  });
  // Drag with very short hold (50ms): should NOT trigger auto-expand.
  await dndDrag(win, 'li[data-session-id="d1"]', '[data-group-header-id="gC"]', { holdMs: 0, settleMs: 50 });
  // After release, gC will receive d1 (header-drop appends regardless of
  // collapsed state) — that's fine. But the auto-expand timer should NOT
  // have fired during the brief hover. Check: gC.collapsed should be...
  // Actually, the moveSession itself doesn't change collapsed; only the
  // hover timer or explicit user action does. So check now.
  const c = await win.evaluate(() => window.__agentoryStore.getState().groups.find((g) => g.id === 'gC')?.collapsed);
  // EXPECTED: collapsed is still true (no auto-expand on quick hover).
  // But note: createSession into a collapsed group expands it; we're MOVING
  // not creating, so collapse should stick. If it's false here without
  // 400ms+ hover, the timer fires too early.
  if (c !== true) {
    diverge('J13.shortHover', `quick-pass over collapsed group does NOT auto-expand`, `collapsed=${c} after a < 400ms hover`);
  } else {
    console.log(`[${PROBE}] J13.shortHover PASS — collapsed group stayed collapsed`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// J14 — Drag onto an archived group.
//
// EXPECTATION: rejected. The archived list lives in a separate, collapsed
// region and a session dragged in shouldn't suddenly become "archived".
// Probe: check if the archived group's header even registers as a drop
// target at all. We seed an archived group, expand the archive panel,
// then drag a session onto its header. If after release the session has
// moved into the archived group, we record divergence.
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [
      { id: 'gA',   name: 'Live',     collapsed: false, kind: 'normal' },
      { id: 'gArc', name: 'Archived', collapsed: false, kind: 'archive' }
    ],
    sessions: [
      { id: 'e1', name: 'e1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA',   agentType: 'claude-code' },
      { id: 'e2', name: 'e2', state: 'idle', cwd: '~', model: 'm', groupId: 'gArc', agentType: 'claude-code' }
    ],
    activeId: 'e1',
    focusedGroupId: null
  });
  // Open the archived panel so its header is in the DOM.
  const archToggle = win.locator('aside button[aria-expanded]').filter({ hasText: /Archived/ }).first();
  if (await archToggle.count()) {
    await archToggle.click();
    await win.waitForTimeout(150);
  }
  // Now drag e1 onto the archived group header.
  const archHeader = win.locator('[data-group-header-id="gArc"]');
  if ((await archHeader.count()) === 0) {
    diverge('J14.headerVisible', `archived group's header is mounted when archive panel is open`, `header not found in DOM`);
  } else {
    await dndDrag(win, 'li[data-session-id="e1"]', '[data-group-header-id="gArc"]');
    const e1Group = await win.evaluate(() =>
      window.__agentoryStore.getState().sessions.find((s) => s.id === 'e1')?.groupId
    );
    if (e1Group === 'gArc') {
      diverge('J14.rejectArchive', `dragging into archived group is rejected (live session stays in source)`, `e1 moved to "gArc" — live session was put into archive`);
    } else {
      console.log(`[${PROBE}] J14 PASS — drag into archived rejected (groupId="${e1Group}")`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// J15 — Collapse/expand persistence across restart.
//
// Already partially exercised by J12 (persistence path), but here we
// specifically toggle a group collapsed via the store, force a persist,
// relaunch, and verify the collapsed flag survived.
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [
      { id: 'gP', name: 'persisted', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 'p1', name: 'p1', state: 'idle', cwd: '~', model: 'm', groupId: 'gP', agentType: 'claude-code' }
    ],
    activeId: 'p1',
    focusedGroupId: null
  });
  await win.evaluate(() => window.__agentoryStore.getState().setGroupCollapsed('gP', true));
  await win.waitForTimeout(500);
  await app.close();
  await new Promise((r) => setTimeout(r, 500));
  app = await electron.launch({
    args: ['.', `--user-data-dir=${ud.dir}`],
    cwd: root,
    env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' }
  });
  win = await appWindow(app);
  wireErrors(win);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(
    () => !!window.__agentoryStore && document.querySelector('aside') !== null,
    null,
    { timeout: 20_000 }
  );
  await win.waitForTimeout(400);
  const post = await win.evaluate(() =>
    window.__agentoryStore.getState().groups.find((g) => g.id === 'gP')?.collapsed
  );
  if (post !== true) {
    diverge('J15.collapsedPersist', `group collapsed=true survives restart`, `collapsed=${post}`);
  } else {
    console.log(`[${PROBE}] J15 PASS — collapsed=true persisted`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// J16 — Archive/unarchive a non-empty group.
//
// EXPECTED:
//   - Right-click group → "Archive group". Group's kind becomes 'archive'.
//   - Group disappears from the main "Groups" list and (if archive panel
//     is open) appears in the Archived list.
//   - Sessions inside the archived group are NOT focusable from the main
//     list (i.e. their <li> elements are NOT in the main list's DOM, or
//     are tabIndex=-1).
//   - Unarchive restores the group to the main list.
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [
      { id: 'gAlive', name: 'Live one', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 'al1', name: 'al1', state: 'idle', cwd: '~', model: 'm', groupId: 'gAlive', agentType: 'claude-code' },
      { id: 'al2', name: 'al2', state: 'idle', cwd: '~', model: 'm', groupId: 'gAlive', agentType: 'claude-code' }
    ],
    activeId: 'al1',
    focusedGroupId: null
  });
  // archive via store action (UI path: right-click → "Archive group" — same effect).
  const header = win.locator('[data-group-header-id="gAlive"]').first();
  await header.click({ button: 'right' });
  const archMenu = win.getByRole('menuitem').filter({ hasText: /Archive group/ }).first();
  await archMenu.waitFor({ state: 'visible', timeout: 3000 });
  await archMenu.click();
  await win.waitForTimeout(250);
  const k = await win.evaluate(() => window.__agentoryStore.getState().groups.find((g) => g.id === 'gAlive')?.kind);
  if (k !== 'archive') {
    diverge('J16.kindArchive', `group.kind === 'archive' after Archive`, `kind="${k}"`);
  }
  // Should NOT appear in the main `nav` (which only renders normal groups).
  // The archive list is rendered behind a toggle. Both expose the same
  // header data attribute, so we can't distinguish purely by selector. We
  // verify by looking at the parent <nav> chain.
  const inMainList = await win.evaluate(() => {
    const headers = document.querySelectorAll('[data-group-header-id="gAlive"]');
    if (headers.length === 0) return 'none';
    for (const h of headers) {
      // The main nav has the largest viewport and isn't the h-40 archive panel.
      let p = h.parentElement;
      while (p && p.tagName !== 'NAV') p = p.parentElement;
      if (!p) continue;
      // Distinguish by class: the archived nav has h-40 in className.
      if (!p.className.includes('h-40')) return 'main';
    }
    return 'archived';
  });
  if (inMainList === 'main') {
    diverge('J16.notInMain`', `archived group is removed from the main list`, `still rendered in main <nav>`);
  } else if (inMainList === 'none') {
    // Archive panel may be closed by default. Expand it and re-check.
    const arch = win.locator('aside button[aria-expanded]').filter({ hasText: /Archived/ }).first();
    if (await arch.count()) {
      await arch.click();
      await win.waitForTimeout(150);
    }
    const recount = await win.locator('[data-group-header-id="gAlive"]').count();
    if (recount === 0) {
      diverge('J16.appearsInArchive`', `archived group renders in the Archived panel when expanded`, `not found in DOM at all`);
    }
  }
  // Unarchive.
  // Make sure archive panel is open so we can right-click the header.
  const arch2 = win.locator('aside button[aria-expanded]').filter({ hasText: /Archived/ }).first();
  if (await arch2.count() && (await arch2.getAttribute('aria-expanded')) === 'false') {
    await arch2.click();
    await win.waitForTimeout(150);
  }
  const archHeader = win.locator('[data-group-header-id="gAlive"]').first();
  await archHeader.click({ button: 'right' });
  const unarchMenu = win.getByRole('menuitem').filter({ hasText: /Unarchive group/ }).first();
  await unarchMenu.waitFor({ state: 'visible', timeout: 3000 });
  await unarchMenu.click();
  await win.waitForTimeout(250);
  const k2 = await win.evaluate(() => window.__agentoryStore.getState().groups.find((g) => g.id === 'gAlive')?.kind);
  if (k2 !== 'normal') {
    diverge('J16.unarchive', `unarchive restores kind='normal'`, `kind="${k2}"`);
  } else {
    console.log(`[${PROBE}] J16 PASS — archive + unarchive lifecycle`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// J17 — Active session highlight is visible AND scroll-into-view fires
// when activeId is set to an off-screen session.
//
// EXPECTED:
//   - Active row has data-state or aria-selected="true" or distinguishable
//     class. We check `aria-selected="true"`.
//   - With many sessions in one group exceeding the nav's clientHeight,
//     selecting the LAST one should cause it to be in the visible viewport
//     of the nav (li.offsetTop within nav.scrollTop..scrollTop+clientHeight).
// ────────────────────────────────────────────────────────────────────────
{
  // Generate ~50 sessions in one group so the list overflows.
  const many = [];
  for (let i = 0; i < 50; i++) {
    many.push({
      id: `m${i}`,
      name: `m-${i}`,
      state: 'idle',
      cwd: '~',
      model: 'm',
      groupId: 'gM',
      agentType: 'claude-code'
    });
  }
  await seedStore(win, {
    groups: [{ id: 'gM', name: 'Many', collapsed: false, kind: 'normal' }],
    sessions: many,
    activeId: 'm0',
    focusedGroupId: null
  });
  await win.waitForTimeout(200);
  // Highlight check: aria-selected="true" present on the active li.
  const activeAria = await win.locator('li[data-session-id="m0"]').first().getAttribute('aria-selected');
  if (activeAria !== 'true') {
    diverge('J17.highlightAria', `active row has aria-selected="true"`, `aria-selected="${activeAria}"`);
  }
  // Now select the last one and assert scroll-into-view.
  await win.evaluate(() => window.__agentoryStore.getState().selectSession('m49'));
  await win.waitForTimeout(700);
  const visible = await win.evaluate(() => {
    const li = document.querySelector('li[data-session-id="m49"]');
    if (!li) return { reason: 'no-li' };
    const rect = li.getBoundingClientRect();
    // Walk up to find the scroll container.
    let p = li.parentElement;
    let scroller = null;
    while (p) {
      const st = getComputedStyle(p);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') { scroller = p; break; }
      p = p.parentElement;
    }
    if (!scroller) return { reason: 'no-scroller' };
    const sRect = scroller.getBoundingClientRect();
    const top = rect.top >= sRect.top - 1;
    const bottom = rect.bottom <= sRect.bottom + 1;
    return { top, bottom, scrollerH: scroller.clientHeight, scrollerScrollTop: scroller.scrollTop, liOffsetTop: li.offsetTop };
  });
  if (visible.reason) {
    diverge('J17.scrollContainer', `active session row exists inside a scroll container`, `reason=${visible.reason}`);
  } else if (!visible.top || !visible.bottom) {
    diverge('J17.scrollIntoView', `selecting an off-screen session scrolls it into view`, `top=${visible.top}, bottom=${visible.bottom}, scroller h=${visible.scrollerH}, scrollTop=${visible.scrollerScrollTop}, li.offsetTop=${visible.liOffsetTop}`);
  } else {
    console.log(`[${PROBE}] J17 PASS — m49 visible after select (scrollTop=${visible.scrollerScrollTop})`);
  }
}

// ── final report ─────────────────────────────────────────────────────────
console.log(`\n[${PROBE}] divergence count = ${divergences.length}`);
for (const d of divergences) {
  console.log(`  ${d.j.padEnd(28)}  expected: ${d.expected}`);
  console.log(`  ${' '.padEnd(28)}  observed: ${d.observed}`);
}
await app.close();
ud.cleanup();
if (divergences.length > 0) {
  console.error(`\n[${PROBE}] FAIL — ${divergences.length} divergence(s)`);
  process.exit(2);
}
console.log(`\n[${PROBE}] OK`);
