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
  // Paste is intentionally OMITTED from this menu. Electron's `role: 'paste'`
  // resolves the Ctrl/Cmd+V accelerator by calling `webContents.paste()`,
  // which only works against a focused contentEditable/textarea via the
  // OS-level paste pathway. For the terminal pane, focus may sit on the
  // xterm helper textarea, the screen canvas, or the host wrapper, and the
  // OS-paste path is a no-op (or worse, silently inserts into the helper
  // textarea instead of the PTY). The terminal pane installs its own
  // capture-phase Ctrl/Cmd+V handler that routes through `ccsmPty.input` —
  // see `src/terminal/xtermSingleton.ts`. Letting the menu accelerator
  // through means it never reaches DOM keydown at all (the menu consumes
  // it first); removing the menu entry lets the keydown propagate
  // normally to the renderer.
  const accelMenu = Menu.buildFromTemplate([
    {
      label: i18n.tMenu('edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
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
   *  leak the claude child past Electron quit. Returns a Promise so the
   *  before-quit handler can await the parallel `taskkill` fanout before
   *  letting Electron tear down — previously the sync version froze the
   *  quit UI for N × 200-2000ms while `spawnSync('taskkill', ...)` ran
   *  serially per session. */
  killAllPtySessions: () => Promise<void> | void;
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

  // Re-entry guard for the async before-quit dance below. Once we've
  // dispatched the async cleanup we call `app.quit()` again, which re-fires
  // `before-quit`; on that second pass we must let Electron proceed
  // unmolested (no preventDefault, no double-cleanup) — otherwise we'd
  // loop forever. The flag is in module scope rather than on the deps bag
  // because it's purely an implementation detail of THIS handler.
  let cleanupStarted = false;

  app.on('before-quit', (event) => {
    setIsQuitting(true);
    if (cleanupStarted) {
      // Second-pass quit after async cleanup resolved — let Electron exit.
      return;
    }
    cleanupStarted = true;

    // Block the synchronous quit so we can wait for the parallel `taskkill`
    // (Windows) / SIGTERM-SIGKILL (POSIX) fanout to settle. Without this,
    // Electron tears down before `killAllPtySessions` finishes, leaving
    // orphaned claude.exe children on Windows AND freezing the visible UI
    // for N × 200-2000ms while the old sync `spawnSync('taskkill')` ran
    // serially per session.
    event.preventDefault();

    const runCleanup = async () => {
      try {
        await killAllPtySessions();
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
      // Re-trigger quit; the re-entry guard above lets this pass through.
      app.quit();
    };
    void runCleanup();
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
