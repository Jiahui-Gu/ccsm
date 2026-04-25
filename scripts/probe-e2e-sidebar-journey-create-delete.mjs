// E2E user-journey probe — sidebar CREATE / DELETE operations.
//
// Covers J1..J7 of `probe-e2e-sidebar-journey-expectations.md`.
//
// Methodology:
// - Each journey states an EXPECTED behavior up-front (the comment block
//   above the case). The probe asserts that expectation.
// - When the assertion fails, we DO NOT silently relax the test. We bail
//   with a precise expected/observed message so the human reviewer can
//   decide whether the product or the expectation is wrong.
// - We use the store as the source of truth for "did this action have its
//   intended effect" (faster, deterministic) and the DOM for "is this
//   visible to the user".
//
// IMPORTANT: probes here intentionally include cases where the author
// EXPECTED divergence from current product behavior (e.g. J4: should not
// confirm-prompt non-active deletes; J5: should fall back to a sibling).
// Those cases will FAIL. That is the whole point — surface the gap.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, seedStore } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PROBE = 'probe-e2e-sidebar-journey-create-delete';
function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-probe-sidebar-journey-cd');
console.log(`[${PROBE}] userData = ${ud.dir}`);

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

async function bail(msg) {
  console.error('--- pageerrors ---\n' + errors.slice(-10).join('\n'));
  try { await app.close(); } catch {}
  ud.cleanup();
  fail(msg);
}

// Divergence recorder. We collect every expected-vs-observed mismatch and
// print them at the end as a single matrix, instead of bailing on the first
// one — the methodology asks us to surface ALL gaps in one pass so the
// human reviewer can triage them as a set.
const divergences = [];
function diverge(j, expected, observed) {
  divergences.push({ j, expected, observed });
  console.log(`[${PROBE}] ${j} DIVERGE — expected: ${expected} | observed: ${observed}`);
}

const state = () => win.evaluate(() => window.__ccsmStore.getState());
const sessionsIn = (gid) =>
  win.evaluate(
    (g) => window.__ccsmStore.getState().sessions.filter((s) => s.groupId === g).map((s) => s.id),
    gid
  );
const groupCollapsed = (gid) =>
  win.evaluate(
    (g) => window.__ccsmStore.getState().groups.find((x) => x.id === g)?.collapsed ?? null,
    gid
  );

// Seed: two normal groups, a-side has 2 sessions, b-side has 1 session.
// active = a2 (so any "active group" logic should target group A).
await seedStore(win, {
  groups: [
    { id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' },
    { id: 'gB', name: 'Group B', collapsed: false, kind: 'normal' },
    { id: 'gArc', name: 'Old', collapsed: false, kind: 'archive' }
  ],
  sessions: [
    { id: 'a1', name: 'a-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
    { id: 'a2', name: 'a-two', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
    { id: 'b1', name: 'b-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
  ],
  activeId: 'a2',
  focusedGroupId: null
});

// ────────────────────────────────────────────────────────────────────────
// J1 — "New session" button creates into the active group.
//
// EXPECTED:
//   - The new session's groupId === activeGroupId of `a2` (= 'gA').
//   - The new session becomes activeId.
//   - The composer textarea receives focus (focusInputNonce bumps).
// ────────────────────────────────────────────────────────────────────────
{
  const before = await state();
  const beforeNonce = before.focusInputNonce;
  const newBtn = win.locator('aside button:has-text("New Session")').first();
  await newBtn.waitFor({ state: 'visible', timeout: 5000 });
  await newBtn.click();
  await win.waitForTimeout(250);
  const after = await state();
  const newId = after.activeId;
  if (!newId || newId === before.activeId) {
    await bail(`J1: activeId did not change after New Session click (was=${before.activeId}, now=${newId})`);
  }
  const ses = after.sessions.find((s) => s.id === newId);
  if (!ses) await bail(`J1: new session id ${newId} missing from sessions[]`);
  if (ses.groupId !== 'gA') {
    diverge('J1.targetGroup', `new session.groupId === "gA" (active group)`, `"${ses.groupId}"`);
  }
  if (after.focusInputNonce <= beforeNonce) {
    diverge('J1.focusNonce', `focusInputNonce bumps after New Session click`, `was=${beforeNonce}, now=${after.focusInputNonce} (no bump)`);
  }
  // Composer focus assert: the textarea[data-input-bar] should be document.activeElement.
  await win.waitForTimeout(150);
  const isFocused = await win.evaluate(() => {
    const ta = document.querySelector('textarea[data-input-bar]');
    return !!ta && document.activeElement === ta;
  });
  if (!isFocused) {
    diverge('J1.composerFocus', `composer textarea is document.activeElement`, `not focused`);
  }
  console.log(`[${PROBE}] J1 done — new session "${newId}" in ${ses?.groupId}`);
}

// ────────────────────────────────────────────────────────────────────────
// J2 — "New group" button creates a fresh group.
//
// EXPECTED:
//   1. Click "New group" "+" → a fresh normal group exists.
//   2. The new group is selected as the active context (focusedGroupId
//      points to it OR a subsequent "New session" lands inside it).
//   3. The new group is expanded (collapsed === false).
//   4. The new group enters inline-rename mode immediately so the user
//      can type a real name without an extra click.
// ────────────────────────────────────────────────────────────────────────
{
  const before = await state();
  const beforeIds = new Set(before.groups.map((g) => g.id));
  const addBtn = win.locator('aside button[aria-label="New group"]').first();
  await addBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addBtn.click();
  await win.waitForTimeout(250);
  const after = await state();
  const created = after.groups.find((g) => !beforeIds.has(g.id));
  if (!created) {
    diverge('J2.exists', `clicking "New group" creates a group`, `no new group appeared`);
  } else {
    if (created.collapsed) diverge('J2.expanded', `new group expanded`, `collapsed=${created.collapsed}`);
    const renameInput = await win.locator(`[data-group-header-id="${created.id}"] input`).count();
    if (renameInput === 0) {
      diverge('J2.rename', `new group enters inline rename mode immediately`, `no <input> in header — user must do extra click to rename`);
    } else {
      // J2 (post-fix): the input should be the document.activeElement so
      // the user can start typing without a click.
      const isFocused = await win.evaluate((gid) => {
        const inp = document.querySelector(`[data-group-header-id="${gid}"] input`);
        return !!inp && document.activeElement === inp;
      }, created.id);
      if (!isFocused) {
        diverge('J2.renameFocused', `inline-rename input is document.activeElement`, `not focused`);
      }
    }
    if (after.focusedGroupId !== created.id) {
      diverge('J2.focused', `focusedGroupId === new group id`, `focusedGroupId="${after.focusedGroupId}" — subsequent "New session" will NOT default into the just-created group`);
    }
    console.log(`[${PROBE}] J2 done — group ${created.id} (collapsed=${created.collapsed})`);
    // Cleanup the rename input if any
    if (renameInput > 0) {
      await win.locator(`[data-group-header-id="${created.id}"] input`).press('Escape').catch(() => {});
      await win.waitForTimeout(100);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// J3 — Per-group "+" button creates into THAT group, not the active one.
//
// EXPECTED:
//   - active session is in gA. Click the "+" on gB's header.
//   - new session lands in gB (NOT gA), and becomes activeId.
//   - gB stays expanded.
//   - Archived groups MUST NOT show a "+" button.
// ────────────────────────────────────────────────────────────────────────
{
  const before = await state();
  if (!before.sessions.some((s) => s.id === before.activeId && s.groupId === 'gA')) {
    await bail(`J3 setup: active is no longer in gA (was=${before.activeId}); seeding broke?`);
  }
  const plusInGB = win.locator('[data-group-header-id="gB"] button[aria-label="New session in this group"]');
  await plusInGB.waitFor({ state: 'visible', timeout: 5000 });
  await plusInGB.click();
  await win.waitForTimeout(250);
  const after = await state();
  const newSes = after.sessions.find((s) => s.id === after.activeId);
  if (!newSes) {
    diverge('J3.created', `per-group "+" creates a new active session`, `no new active session`);
  } else if (newSes.groupId !== 'gB') {
    diverge('J3.targetGroup', `new session.groupId === "gB" (the clicked group)`, `"${newSes.groupId}" — per-group "+" leaks to other group`);
  }
  // Archived groups must NOT show the +.
  const plusInArchived = await win
    .locator('[data-group-header-id="gArc"] button[aria-label="New session in this group"]')
    .count();
  if (plusInArchived !== 0) {
    diverge('J3.archivedNoPlus', `archived group does NOT render "+" button`, `count=${plusInArchived} — user can create live sessions in archive`);
  }
  console.log(`[${PROBE}] J3 done`);
}

// ────────────────────────────────────────────────────────────────────────
// J4 — Deleting a non-active session from sidebar.
//
// EXPECTED (post-fix):
//   - Right-click a non-active session → "Delete".
//   - The row vanishes from the sidebar WITHOUT a confirm dialog.
//   - An "undo" toast appears; clicking Undo restores the row + its
//     messages at the original index.
//
// J4b (RELAXED): right-clicking a row IS allowed to select it. We assert
// that the right-clicked row becomes the active selection (matches GUI
// norms — context menu for "this row" should select "this row").
// ────────────────────────────────────────────────────────────────────────
{
  // Re-seed minimal — the previous cases left a lot of churn.
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' },
      { id: 'gB', name: 'Group B', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 'k1', name: 'keep one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'k2', name: 'doomed',   state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'k3', name: 'b only',   state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
    ],
    activeId: 'k1',
    focusedGroupId: null,
    messagesBySession: {
      k2: [{ id: 'm1', kind: 'user-text', text: 'hello from k2', createdAt: 1 }]
    }
  });
  // Seed some draft text into k2 so we can verify the undo restores it.
  await win.evaluate(() => {
    // Write directly via the drafts module — exposed only for tests/probes
    // through window.__ccsmStore in real life; here we just persist via
    // the store's saveState and re-load on restoreSession (handled inside).
    // We reach in via the drafts module indirectly: enqueue a draft using a
    // fake hook is overkill — instead, we inject through localStorage-like
    // persistence is also not reachable. Skip draft round-trip in this
    // probe; J4 already validates message restoration.
  });

  const row = win.locator('li[data-session-id="k2"]').first();
  await row.click({ button: 'right' });
  // J4b: right-click should select the row.
  await win.waitForTimeout(150);
  const afterRC = await state();
  if (afterRC.activeId !== 'k2') {
    diverge('J4b.rightClickSelects', `right-click selects the clicked row (activeId === "k2")`, `activeId="${afterRC.activeId}"`);
  }
  const del = win.getByRole('menuitem').filter({ hasText: /^Delete$/ }).first();
  await del.waitFor({ state: 'visible', timeout: 3000 });
  await del.click();
  await win.waitForTimeout(250);
  // EXPECTATION: NO dialog (soft-delete + toast replaces confirm gate).
  const dialogCount = await win.locator('[role="dialog"]').count();
  if (dialogCount > 0) {
    const tx = await win.locator('[role="dialog"] h2, [role="dialog"] [id*="title"]').first().textContent().catch(() => '<no title>');
    diverge('J4.noConfirm', `non-active session delete is silent (no modal)`, `confirm dialog opened (title="${(tx || '').trim()}")`);
    // Try to dismiss so subsequent assertions are clean.
    await win.keyboard.press('Escape').catch(() => {});
    await win.waitForTimeout(150);
  }
  // Row vanished?
  const stillThere = await win.locator('li[data-session-id="k2"]').count();
  if (stillThere !== 0) {
    diverge('J4.removed', `row k2 disappears after Delete`, `still present (count=${stillThere})`);
  }
  const afterDel = await state();
  if (afterDel.sessions.some((s) => s.id === 'k2')) {
    diverge('J4.removedStore', `k2 removed from sessions[]`, `still present`);
  }

  // Undo toast: click "Undo" — row should come back, messages too.
  const undoBtn = win.locator('button').filter({ hasText: /^Undo$/ }).first();
  const haveUndo = await undoBtn.count();
  if (haveUndo === 0) {
    diverge('J4.undoToast', `undo toast appears with an "Undo" button after delete`, `no undo button found in DOM`);
  } else {
    await undoBtn.click();
    await win.waitForTimeout(250);
    const restored = await state();
    if (!restored.sessions.some((s) => s.id === 'k2')) {
      diverge('J4.undoRestores', `clicking Undo restores k2 to sessions[]`, `still missing after undo`);
    }
    const msgs = restored.messagesBySession.k2;
    if (!msgs || msgs.length === 0) {
      diverge('J4.undoMessages', `undo restores messages for k2`, `messagesBySession.k2 = ${JSON.stringify(msgs)}`);
    }
  }
  console.log(`[${PROBE}] J4 done`);
}

// ────────────────────────────────────────────────────────────────────────
// J5 — Deleting the ACTIVE session falls back to a SIBLING in the same group.
//
// EXPECTED:
//   - Active=k1 (only session left in gA after J4). Add a sibling.
//   - Setup: gA contains [k1, k1b]. activeId=k1.
//   - Delete k1 → expect activeId === 'k1b' (same-group sibling) — NOT
//     'k3' from gB (which would be "first remaining session anywhere").
// ────────────────────────────────────────────────────────────────────────
{
  // CRUCIAL ordering: place a non-sibling FIRST in sessions[] so the naive
  // "remaining[0]" fallback would pick "other" — a same-group sibling
  // strategy must instead pick "k1b". This is what makes the case strict.
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' },
      { id: 'gB', name: 'Group B', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 'k3',  name: 'other',  state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' },
      { id: 'k1',  name: 'active', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'k1b', name: 'sibling', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
    ],
    activeId: 'k1',
    focusedGroupId: null
  });
  // Drive deletion programmatically (still goes through deleteSession in store)
  // since J4 already covered the UI path / dialog presence.
  await win.evaluate(() => window.__ccsmStore.getState().deleteSession('k1'));
  await win.waitForTimeout(200);
  const after = await state();
  if (after.activeId !== 'k1b') {
    diverge('J5.siblingFallback', `activeId falls back to same-group sibling "k1b"`, `activeId="${after.activeId}" — fallback uses "first remaining session anywhere", losing the user's group context`);
  }
  console.log(`[${PROBE}] J5 done — activeId="${after.activeId}"`);
}

// ────────────────────────────────────────────────────────────────────────
// J6 — Deleting a session whose agent is "running" must not crash and
//      must clean up runningSessions / messageQueues.
//
// EXPECTED (store-level, since spawning a real claude.exe is out of scope):
//   - delete on a session with runningSessions[id]=true & a message in queue
//     → session removed; runningSessions[id] cleared; messageQueues[id] cleared.
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [{ id: 'gA', name: 'Group A', collapsed: false, kind: 'normal' }],
    sessions: [
      { id: 'r1', name: 'running', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'r2', name: 'idle',    state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
    ],
    activeId: 'r2',
    focusedGroupId: null,
    runningSessions: { r1: true },
    startedSessions: { r1: true },
    messageQueues: { r1: [{ id: 'q1', text: 'pending msg', images: [] }] }
  });
  await win.evaluate(() => window.__ccsmStore.getState().deleteSession('r1'));
  await win.waitForTimeout(200);
  const after = await state();
  if (after.sessions.some((s) => s.id === 'r1')) diverge('J6.removed', `r1 removed from sessions[]`, `still present`);
  if (after.runningSessions.r1 !== undefined) diverge('J6.runningCleared', `runningSessions.r1 cleared`, `=${after.runningSessions.r1}`);
  if (after.startedSessions.r1 !== undefined) diverge('J6.startedCleared', `startedSessions.r1 cleared`, `=${after.startedSessions.r1}`);
  if (after.messageQueues.r1 !== undefined) diverge('J6.queueCleared', `messageQueues.r1 cleared`, `=${JSON.stringify(after.messageQueues.r1)}`);
  console.log(`[${PROBE}] J6 done`);
}

// ────────────────────────────────────────────────────────────────────────
// J7 — Deleting a non-empty group.
//
// EXPECTED:
//   - Right-click group → Delete group… → confirm dialog appears.
//   - Confirming wipes both the group and ALL its sessions.
//   - If activeId pointed inside the group, fallback applies.
//   - An undo toast appears; clicking Undo restores the group AND every
//     member session, in original order.
// ────────────────────────────────────────────────────────────────────────
{
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'GroupA', collapsed: false, kind: 'normal' },
      { id: 'gB', name: 'GroupB', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'a2', name: 'a2', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'b1', name: 'b1', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
    ],
    activeId: 'a1',
    focusedGroupId: null
  });
  // Dismiss any lingering toasts from earlier journeys (J4's session-undo
  // toast can still be in DOM if its 3s TTL hasn't elapsed) so the locator
  // below resolves to J7's group-undo toast unambiguously.
  await win.evaluate(() => {
    const t = window.__ccsmToast;
    if (!t) return;
    document.querySelectorAll('[data-toast-id]').forEach((el) => {
      const id = el.getAttribute('data-toast-id');
      if (id) t.dismiss(id);
    });
  });
  await win.waitForTimeout(150);
  const header = win.locator('[data-group-header-id="gA"]').first();
  await header.click({ button: 'right' });
  const delMenu = win.getByRole('menuitem').filter({ hasText: /Delete group/ }).first();
  await delMenu.waitFor({ state: 'visible', timeout: 3000 });
  await delMenu.click();
  await win.waitForTimeout(200);
  // Confirm dialog should be open (group delete IS more destructive — gate stays).
  const dlg = win.locator('[role="dialog"]');
  if ((await dlg.count()) === 0) {
    diverge('J7.confirm', `non-empty group delete shows confirm dialog`, `no dialog appeared`);
  } else {
    const confirmBtn = win.locator('[role="dialog"] button').filter({ hasText: /^Delete group$/ }).first();
    if ((await confirmBtn.count()) === 0) {
      diverge('J7.confirmBtn', `dialog has "Delete group" button`, `button not found`);
    } else {
      await confirmBtn.click();
      await win.waitForTimeout(300);
    }
  }
  const after = await state();
  if (after.groups.some((g) => g.id === 'gA')) diverge('J7.groupGone', `group gA removed after confirm`, `still present`);
  if (after.sessions.some((s) => s.groupId === 'gA')) {
    diverge('J7.cascadeSessions', `sessions of gA cascaded out`, `leaked: ${after.sessions.filter((s) => s.groupId === 'gA').map((s) => s.id).join(',')}`);
  }
  const orphan = after.activeId !== '' && !after.sessions.some((s) => s.id === after.activeId);
  if (orphan) {
    diverge('J7.noOrphan', `activeId points at a real session or empty`, `activeId="${after.activeId}" — orphan id`);
  }
  if (!orphan && after.activeId !== 'b1' && after.activeId !== '') {
    diverge('J7.fallback', `activeId falls back to "b1"`, `activeId="${after.activeId}"`);
  }
  // Undo toast restores group + all members in original order.
  const undoBtn = win.locator('button').filter({ hasText: /^Undo$/ }).first();
  if ((await undoBtn.count()) === 0) {
    diverge('J7.undoToast', `undo toast appears after group delete`, `no Undo button found`);
  } else {
    await undoBtn.click();
    await win.waitForTimeout(300);
    const restored = await state();
    if (!restored.groups.some((g) => g.id === 'gA')) {
      diverge('J7.undoGroup', `undo restores group gA`, `still missing`);
    }
    const memberIds = restored.sessions.filter((s) => s.groupId === 'gA').map((s) => s.id);
    if (memberIds.join(',') !== 'a1,a2') {
      diverge('J7.undoMembersOrder', `undo restores [a1,a2] in original order`, `[${memberIds.join(',')}]`);
    }
  }
  console.log(`[${PROBE}] J7 done — activeId="${after.activeId}"`);
}

// ── final report ─────────────────────────────────────────────────────────
console.log(`\n[${PROBE}] divergence count = ${divergences.length}`);
for (const d of divergences) {
  console.log(`  ${d.j.padEnd(22)}  expected: ${d.expected}`);
  console.log(`  ${' '.padEnd(22)}  observed: ${d.observed}`);
}
await app.close();
ud.cleanup();
if (divergences.length > 0) {
  console.error(`\n[${PROBE}] FAIL — ${divergences.length} divergence(s)`);
  process.exit(2);
}
console.log(`\n[${PROBE}] OK`);
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
