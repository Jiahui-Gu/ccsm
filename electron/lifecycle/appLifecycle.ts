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
import { BrowserWindow, Menu } from 'electron';

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
   *  leak the claude child past Electron quit. Returns a Promise that
   *  resolves after every session's graceful-flush + kill settles (or
   *  the 3 s wedged-fallback fires) — `before-quit` awaits this so claude
   *  has time to drain its 100 ms-buffered JSONL writer before the
   *  Electron process exits. See `ptyHost/lifecycle.ts:killAll`. */
  killAllPtySessions: () => Promise<void>;
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

// Quit-after-flush latch. Set on the FIRST `before-quit` we intercept so
// the SECOND `before-quit` (re-fired via `app.quit()` after the async
// flush settles) falls through without re-running the graceful path.
// Module-level (like the now-unused `isQuitting` pattern in main.ts) so
// the handler closure reads the live value.
let flushingForQuit = false;

/** Test hook — reset the quit latch between tests. NOT exported on the
 *  public surface (no entry in the barrel); imported only by the unit
 *  test file via the relative path. */
export function __resetFlushingForQuitForTests(): void {
  flushingForQuit = false;
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

  app.on('before-quit', (event) => {
    setIsQuitting(true);

    // Second-pass: we already ran the graceful flush and re-fired
    // `app.quit()`. Let Electron tear down normally.
    if (flushingForQuit) return;

    // First-pass: the graceful kill path in `ptyHost/lifecycle.ts` writes
    // `\x03` and waits up to 3 s per session for claude to drain its
    // 100 ms-buffered JSONL writer. If we let Electron exit synchronously
    // here, the OS would reap claude before the flush completed — worse
    // than the pre-graceful hard-kill path. So:
    //   1. Hide every window immediately so the user sees the app "quit"
    //      with zero perceptible latency. We DON'T `close()` them — close
    //      would re-enter the tray-resident hide-to-tray logic and other
    //      window listeners; hide is a pure visibility flip.
    //   2. `event.preventDefault()` to abort THIS quit pass.
    //   3. Latch `flushingForQuit = true`.
    //   4. Await `killAllPtySessions()` (now Promise-returning) and
    //      `disposeNotifyPipeline()`.
    //   5. Re-fire `app.quit()`; the handler re-enters with the latch set
    //      and falls through, Electron walks `window-all-closed` →
    //      `closeDb()` → process exit.
    try {
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.hide(); } catch { /* window may already be destroyed */ }
      }
    } catch {
      /* getAllWindows itself can throw on partial-init paths; flush
         must still run even if the UI hide failed. */
    }

    event.preventDefault();
    flushingForQuit = true;

    void (async () => {
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
      // Re-fire quit. The handler closure reads `flushingForQuit` live
      // (module-level) and returns early on this second pass.
      app.quit();
    })();
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
