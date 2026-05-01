// Single-instance lock — the actual zombie-source plug. Extracted from
// electron/main.ts (Task #742 Phase C).
//
// The custom title-bar "X" button hides the window into the tray
// (intentional, see win.on('close') in createWindow); subsequent
// double-clicks of the desktop icon would otherwise spawn a brand-new main
// process every time, leaving the prior one alive and hidden. Calling this
// at module load (before app.whenReady) ensures the second instance bails
// out before it can build any window.
//
// Skipped under E2E so probe runs that spawn the app multiple times in
// parallel (each with their own CCSM_TMP_HOME / CLAUDE_CONFIG_DIR) don't
// collide on the global lock and exit unexpectedly.

import { app, BrowserWindow } from 'electron';

/** Returns true iff we should opt out of the lock. Pure helper — exported
 *  for unit tests.
 *
 *  Skips when:
 *  - E2E env vars are set (probes spawn the app multiple times in parallel)
 *  - The current electron is unpackaged (dev mode via `npm run dev`). This
 *    prevents the dev electron from silently exiting when the user's
 *    installed (packaged) CCSM.exe is also running and already holds the
 *    global single-instance lock. Production (packaged) builds keep the
 *    lock so double-clicking the desktop icon doesn't spawn duplicates. */
export function shouldSkipSingleInstanceLock(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CCSM_E2E_HIDDEN === '1') return true;
  if (env.CCSM_E2E_NO_SINGLE_INSTANCE === '1') return true;
  // Dev mode: skip lock so `npm run dev` doesn't lose the contest when the
  // user's installed (packaged) CCSM is also running.
  try {
    if (app && app.isPackaged === false) return true;
  } catch {
    // app may be unavailable in unit tests — treat as packaged (don't skip).
  }
  return false;
}

/** Acquire the single-instance lock + register the second-instance focus
 *  handler. If we're not the primary instance, calls `app.quit()` and
 *  `process.exit(0)` so the duplicate process disappears immediately. */
export function acquireSingleInstanceLock(): void {
  if (shouldSkipSingleInstanceLock(process.env)) return;
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      w.focus();
    }
  });
}
