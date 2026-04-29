// Themed harness — DND cluster (visible-mode).
//
// Per docs/e2e/single-harness-brainstorm.md §8 (option B + C). Each case
// below is the de-duplicated body of one of the per-file probes in
// scripts/probe-e2e-*.mjs. Absorbed probe files have been deleted (#72
// no-skipped-e2e rule — no breadcrumb files).
//
// WHY A SEPARATE HARNESS (not absorbed into harness-ui):
//   harness-ui launches electron once with CCSM_E2E_HIDDEN='1' (the default
//   off-screen / backgroundThrottling-off mode that keeps batch run-all-e2e
//   from popping ~60 windows). dnd-kit's PointerSensor + collision
//   detection + hover-to-expand timer rely on Chromium-level pointer
//   hit-testing and full-rate rAF; in hidden mode the leftover DragOverlay
//   element from one drag intermittently intercepts pointer events for the
//   next drag. Per-case env overrides aren't supported by harness-runner
//   (#335 capability set covers preMain/setupBefore/userDataDir/relaunch
//   but env is fixed at the shared electron launch). Visible mode therefore
//   has to be set at the harness level. Keeping it as its own harness
//   isolates the ~2s window pop to one launch instead of leaking it into
//   the otherwise-hidden harness-ui run.
//
// SCOPE TODAY: 1 case (`dnd`). This harness is the future home for any
// other visible-mode-only e2e — keeping the visible-mode launch overhead
// amortized across cases as more arrive.
//
// Run: `node scripts/harness-dnd.mjs`
// Run one case: `node scripts/harness-dnd.mjs --only=dnd`

import { dndDrag, seedStore } from './probe-utils.mjs';
import { runHarness } from './probe-helpers/harness-runner.mjs';

// ---------- dnd ----------
//
// Cross-group drag & drop, plus drag-handle vs inline-rename coexistence.
// Fixture seeded directly into window.__ccsmStore (no SDK / API key
// involved). Verifies:
//   1. Drag a session into a DIFFERENT (already-open) group's header → the
//      session now lives inside that group's <ul> in the DOM.
//   2. Drag a session onto a COLLAPSED group's header → after 400ms hover,
//      the group auto-expands, and on release the session lands inside it.
//   3. With a session row in inline-rename mode, the rename input remains
//      interactive (typing reaches the input) — i.e. dnd-kit's pointer
//      listeners on the row don't swallow the rename input's
//      focus/keystrokes.
//
// IMPORTANT: dnd-kit's PointerSensor listens for native PointerEvents.
// Playwright's `mouse.down/move/up` API dispatches MouseEvents, which
// Chromium does not synthesize PointerEvents from in a way the sensor
// picks up. We use the dndDrag helper which dispatches real
// PointerEvents on document — this is what makes the drag actually move.
async function caseDnd({ win, log }) {
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

  if (!(await groupContains('g1', 's1'))) throw new Error('fixture: s1 not in g1');
  if (!(await groupContains('g2', 's3'))) throw new Error('fixture: s3 not in g2');
  if (await groupIsOpen('g3')) throw new Error('fixture: g3 should start collapsed');

  // === Case 1: open → open. s1 (g1) → g2 header. ===
  await dndDrag(
    win,
    'li[data-session-id="s1"]',
    '[data-group-header-id="g2"]'
  );
  if (await groupContains('g1', 's1')) throw new Error('s1 still in g1 after drag to g2 header');
  if (!(await groupContains('g2', 's1'))) throw new Error('s1 did not land in g2 after cross-group drag');

  // === Case 2: open → collapsed. s2 (g1) → g3 header. Hover must auto-expand. ===
  // holdMs=1500 gives the timer plenty of slack on slower runners (was 700;
  // macOS CI was racing the 400ms hover-to-expand timer because dnd-kit's
  // collision detection takes longer to flag isOver=true than on win/linux).
  await dndDrag(
    win,
    'li[data-session-id="s2"]',
    '[data-group-header-id="g3"]',
    { holdMs: 1500 }
  );
  if (!(await groupIsOpen('g3'))) throw new Error('g3 did NOT auto-expand after 1500ms hover');
  if (await groupContains('g1', 's2')) throw new Error('s2 still in g1 after drag to g3 header');
  if (!(await groupContains('g3', 's2'))) throw new Error('s2 did not land in g3 after hover-expand drop');

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
  await renameInput.fill('renamed via probe');
  await renameInput.press('Enter');
  await win.waitForTimeout(300);
  const after = await win.evaluate(() => {
    const s = window.__ccsmStore.getState().sessions.find((x) => x.id === 's3');
    return s ? s.name : null;
  });
  if (after !== 'renamed via probe') {
    throw new Error(`rename did not commit; expected "renamed via probe", got "${after}"`);
  }

  log('s1 g1→g2 header drop; s2 g1→g3 hover-expand drop; s3 inline rename works under dragHandle');
}

// ---------- harness spec ----------
await runHarness({
  name: 'dnd',
  // Opt out of CCSM_E2E_HIDDEN: dnd-kit's collision detection and
  // hover-to-expand timer rely on Chromium-level pointer hit-testing
  // and full-rate rAF. Even with show:true off-screen + backgroundThrottling
  // off, the leftover DragOverlay element from one drag intermittently
  // intercepts pointer events for the next drag in hidden mode. This
  // harness therefore launches with a visible window (~2s pop). The
  // other harnesses stay hidden during run-all-e2e batches.
  launch: { env: { CCSM_E2E_HIDDEN: '0' } },
  cases: [
    { id: 'dnd', run: caseDnd }
  ]
});
