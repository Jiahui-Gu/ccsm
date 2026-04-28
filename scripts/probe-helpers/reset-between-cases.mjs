// Shared helper: reset shared Electron + renderer state between harness cases.
//
// Background — see docs/e2e/single-harness-brainstorm.md §3.
// One Electron process serves multiple cases inside a "themed harness"
// (harness-agent.mjs, harness-permission.mjs, ...). The brainstorm enumerates
// what *isn't* per-session and therefore must be reset by hand:
//
//   1. zustand store singleton (sessions, groups, activeId, dialogs, queues,
//      focus nonce, ...). Settings (theme/language/font) are KEPT — switching
//      them is a per-case concern, the case is responsible for restoring.
//   2. agent subprocesses owned by main (`agent:close` IPC for each session).
//   3. SQLite `app_state` rows outside the persisted-keys allowlist + all
//      rows in `messages`. The DB handle is shared across cases; leftover
//      rows from case N would re-hydrate into case N+1 on a renderer reload.
//   4. Renderer-side global side effects: open Radix portals (dialog /
//      popover / dropdown / context-menu), DOM selection, document.activeElement.
//   5. Caller-supplied dispose functions for monkey-patches the case set up
//      (`dialog.showOpenDialog`, `shell.openPath`, ...) — caller passes them
//      via `registerDispose` returned from `caseScope`.
//
// What this helper INTENTIONALLY does NOT do:
//   - It does NOT reload the renderer. That would cost a ~500ms hydrate cycle
//     per case and re-introduce cold-start noise we're trying to avoid.
//   - It does NOT reset i18n language or theme. Those are persisted user
//     preferences; cases that flip them must restore in their own dispose.
//   - It does NOT kill the Electron process. That defeats the whole point.
//
// `app_state` actually stores ONE row keyed `main` with the entire persisted
// snapshot as a JSON blob (see src/stores/persist.ts STATE_KEY). So we can't
// "keep theme but wipe sessions" via a row-level DELETE — we'd have to read,
// rewrite, and re-save the JSON. The cleaner answer for the harness model is:
// reset the renderer store to a known empty baseline, let the debounced
// persister overwrite the `main` row with that empty snapshot, and additionally
// wipe `messages` (which IS row-per-session-keyed). Keeping the keep-list as
// a future-proof spot in case persist.ts ever splits keys into rows.
const APP_STATE_KEEP = new Set([
  // currently empty — see comment above. If/when persist.ts splits keys, list
  // the survivors here (e.g. 'theme', 'fontSize', 'fontSizePx').
]);

/**
 * Reset shared state so the next case starts from a clean baseline.
 *
 * @param {import('playwright').ElectronApplication} app
 * @param {import('playwright').Page} win
 * @param {object} [opts]
 * @param {Array<() => (void | Promise<void>)>} [opts.disposers]
 *   Caller-collected dispose callbacks for monkey-patches / listeners
 *   registered by the previous case. Each is awaited; errors are swallowed
 *   so one bad disposer can't strand the harness.
 */
export async function resetBetweenCases(app, win, opts = {}) {
  const disposers = opts.disposers ?? [];

  // 1. Run caller disposers FIRST so monkey-patched main-process modules are
  //    restored before we ask main for the live session list.
  for (const fn of disposers.splice(0)) {
    try { await fn(); } catch { /* swallow */ }
  }

  // 2. Close every open agent subprocess via IPC. Iterate from the renderer
  //    so we hit the exact same code path the user does (Delete Session).
  await win.evaluate(async () => {
    const ids = (window.__ccsmStore?.getState().sessions ?? []).map((s) => s.id);
    for (const id of ids) {
      try { await window.ccsm?.agentClose?.(id); } catch { /* ignore */ }
    }
  }).catch(() => { /* renderer may have just navigated; not fatal */ });

  // 3. Reset zustand store to a minimal clean baseline. We can't call a
  //    "resetAll()" because the store doesn't expose one — but setState with
  //    explicit empty maps is sufficient for the keys cases actually exercise.
  //    Settings keys (theme/language/font) are deliberately not touched.
  await win.evaluate(() => {
    const store = window.__ccsmStore;
    if (!store) return;
    store.setState({
      sessions: [],
      groups: [],
      activeId: '',
      messagesBySession: {},
      messageQueues: {},
      runningSessions: {},
      startedSessions: {},
      interruptedSessions: {},
      statsBySession: {},
      focusInputNonce: 0,
      focusTarget: null,
      paletteOpen: false,
      dialogOpen: null,
    });
  }).catch(() => {});

  // 4. Truncate DB tables. `messages` is row-per-session, safe to fully wipe.
  //    `app_state` stores both the main store snapshot (key=`main`) AND the
  //    composer-draft cache (key=`drafts`, see src/stores/drafts.ts). We
  //    delete both so a subsequent reload (or a case that re-uses an old
  //    session id) doesn't pick up leftover drafts. The `drafts` cache is
  //    module-scope inside the renderer, so even after this delete an
  //    in-flight case will need to call `ta.fill('')` to scrub the live
  //    cache — DB cleanup only protects against next-launch hydration.
  await app.evaluate(async (_main, keepKeys) => {
    try {
      const path = require('node:path');
      const Database = require('better-sqlite3');
      const { app: electronApp } = require('electron');
      const dbPath = path.join(electronApp.getPath('userData'), 'ccsm.db');
      const db = new Database(dbPath);
      db.exec('DELETE FROM messages;');
      if (keepKeys.length === 0) {
        db.exec('DELETE FROM app_state;');
      } else {
        const placeholders = keepKeys.map(() => '?').join(',');
        db.prepare(`DELETE FROM app_state WHERE key NOT IN (${placeholders});`).run(...keepKeys);
      }
      db.close();
    } catch {
      // DB may not exist yet for the very first case; not fatal.
    }
  }, [...APP_STATE_KEEP]).catch(() => {});

  // 5. Renderer-side globals: dismiss open Radix portals, blur active element,
  //    clear DOM selection. Radix mounts portals (Dialog, Popover, Dropdown,
  //    ContextMenu) as direct children of <body>. We attack them three ways:
  //      a) press Escape to give Radix a chance to close cleanly (drives
  //         onOpenChange and unmounts via the normal lifecycle).
  //      b) flip every `data-state="open"` to `closed` so animation handlers
  //         tear down trees that ignored Escape.
  //      c) hard-remove any leftover overlay/portal containers as a backstop —
  //         a stuck `fixed inset-0` overlay swallows pointer events for the
  //         next case, which is the most insidious failure mode we've seen.
  await win.evaluate(async () => {
    try { window.getSelection()?.removeAllRanges?.(); } catch {}
    try {
      const el = document.activeElement;
      if (el && typeof el.blur === 'function') el.blur();
    } catch {}
    try {
      // (a) Escape twice — covers stacked portals (e.g. context menu in dialog).
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    } catch {}
    // Yield a microtask + animation frame so React effects run.
    await new Promise((r) => setTimeout(r, 60));
    try {
      // (b) Force-close anything still open by data-state, then (c) yank the
      // portal nodes themselves. We do BOTH because some Radix components
      // remount on next open while others rely on the existing node staying
      // around — covering both is cheap.
      document.querySelectorAll('[data-state="open"]').forEach((n) => {
        try { n.setAttribute('data-state', 'closed'); } catch {}
      });
      document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((n) => n.remove());
      // Radix Dialog overlay + content sit under <body> with role=dialog or
      // a class containing `inset-0`. Only remove direct body children to
      // avoid blowing up the app's own layout.
      Array.from(document.body.children).forEach((n) => {
        const role = n.getAttribute('role');
        const cls = (n.getAttribute('class') ?? '').toString();
        const isOverlay = cls.includes('inset-0') && (cls.includes('bg-black') || cls.includes('backdrop'));
        const isDialog = role === 'dialog' || role === 'alertdialog';
        if (isOverlay || isDialog) {
          try { n.remove(); } catch {}
        }
      });
    } catch {}
  }).catch(() => {});
}
