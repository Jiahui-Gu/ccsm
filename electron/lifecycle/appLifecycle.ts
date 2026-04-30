// App-level lifecycle wiring. Extracted from electron/main.ts (Task #742
// Phase C).
//
// Owns the small but cross-cutting bits:
//   * applyAppMenuLocale — install the hidden Edit-role menu so
//     copy/paste/etc. accelerators stay live on Windows/Linux even though
//     CCSM doesn't render an OS menu bar. Re-runs on locale change so the
//     "Edit" label tracks the active language.
//   * registerLifecycleHandlers — `app.on('before-quit')`,
//     `app.on('window-all-closed')`, `app.on('activate')`. All three
//     mutate cross-module state owned by main.ts (isQuitting flag, db
//     close, createWindow factory) so they take a deps bag.
//
// The `app.whenReady()` body itself stays in main.ts — it's the
// orchestration site that wires every subsystem together (db init, IPC
// registration, notify pipeline construction, ptyHost, sessionWatcher).
// Extracting it would just create a giant deps bag with no real win.

import type { App } from 'electron';
import { Menu } from 'electron';

/** Build + install the hidden app accelerator menu. We don't want a visible
 *  File/Edit/View menu bar — CCSM is a single-window tool and those menus
 *  add noise. But on Windows/Linux, setting the app menu to null also
 *  removes the built-in Edit-role accelerators (Ctrl+C / Ctrl+V / Ctrl+X /
 *  Ctrl+A / Ctrl+Z), which makes chat content feel "not copyable". This
 *  installs a minimal, hidden menu whose only job is to carry those
 *  accelerators. On macOS, the default app menu already handles this, but
 *  the override is harmless.
 *
 *  Wrapped in a function so language switches via `ccsm:set-language` can
 *  rebuild the menu with the localized "Edit" label (mirrors the
 *  `applyTrayLocale()` pattern). The submenu items use Electron `role`s
 *  and are localized by the OS automatically. */
export function applyAppMenuLocale(): void {
  // Local require keeps the import graph linear (avoids a circular ts-tree
  // edge with electron/i18n.ts that the top-level main.ts call also worked
  // around).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = require('../i18n') as typeof import('../i18n');
  const accelMenu = Menu.buildFromTemplate([
    {
      label: i18n.tMenu('edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]);
  Menu.setApplicationMenu(accelMenu);
}

export interface LifecycleDeps {
  app: App;
  /** Read latest isQuitting flag for the window-all-closed handler. */
  getIsQuitting: () => boolean;
  /** Flip isQuitting → true on `before-quit`. The window's close handler
   *  reads this to short-circuit hide-to-tray when an explicit quit path
   *  fired (tray Quit, OS shutdown, updater install). */
  setIsQuitting: (v: boolean) => void;
  /** Best-effort reap of any live node-pty children spawned through
   *  ptyHost. Idempotent; critical on Windows where conpty can otherwise
   *  leak the claude child past Electron quit. */
  killAllPtySessions: () => void;
  /** Tear down the notify pipeline + its app-level listeners (focus/blur,
   *  sessionWatcher 'unwatched') and any pending flash timers. Optional
   *  because `before-quit` may fire before the pipeline is constructed
   *  (e.g. early failure in app.whenReady). Idempotent on its own.
   *  Audit #876 cluster 1.14 + 3.8 / Task #884. */
  disposeNotifyPipeline?: () => void;
  /** Close the SQLite handle on a real quit. */
  closeDb: () => void;
  /** Spawn a fresh main window from the macOS dock-click `activate` path
   *  when every BrowserWindow has been destroyed. */
  createWindow: () => void;
  /** Read live BrowserWindow count so `activate` only spawns when needed. */
  getWindowCount: () => number;
}

export function registerLifecycleHandlers(deps: LifecycleDeps): void {
  const {
    app,
    getIsQuitting,
    setIsQuitting,
    killAllPtySessions,
    closeDb,
    createWindow,
    getWindowCount,
    disposeNotifyPipeline,
  } = deps;

  app.on('before-quit', () => {
    setIsQuitting(true);
    try {
      killAllPtySessions();
    } catch {
      /* ignore — best-effort cleanup on quit */
    }
    if (disposeNotifyPipeline) {
      try {
        disposeNotifyPipeline();
      } catch {
        /* ignore — best-effort cleanup on quit */
      }
    }
  });

  app.on('window-all-closed', () => {
    // Tray-resident: do NOT quit on Windows when the window closes; the
    // user explicitly chose minimize-to-tray. Real quit goes through tray
    // Quit / Ctrl-Q.
    if (getIsQuitting()) {
      closeDb();
      app.quit();
    }
  });

  app.on('activate', () => {
    if (getWindowCount() === 0) createWindow();
  });
}
