// System tray icon + menu construction. Extracted from electron/main.ts
// (Task #731 Phase A2).
//
// The tray is a singleton (Electron's Tray needs a stable handle so the OS
// keeps the icon in the notification area). The factory below returns a
// controller object with the live Tray reference and a `applyLocale()` hook
// that main.ts calls when the renderer flips the UI language.
//
// Why dependency injection: showing the window requires reaching the live
// BrowserWindow list AND the createWindow factory (when no window exists,
// e.g. after the user closed-to-tray and the OS evicted the renderer). The
// quit menu item flips the cross-module `isQuitting` flag. Both are passed
// in so this module stays leaf-of-graph (no electron/main.ts back-import).

import { BrowserWindow, Menu, Tray, app } from 'electron';
import { buildTrayIcon } from '../branding/icon';

export interface TrayDeps {
  /** Spawn a fresh main window when the tray is clicked but every
   *  BrowserWindow has been destroyed. Implementation lives in main.ts and
   *  closes over the createWindow factory + dependencies. */
  createMainWindow: () => void;
  /** Flip the cross-module isQuitting flag so the close handler knows to
   *  let the window die instead of hide-to-tray. */
  setIsQuitting: (v: boolean) => void;
}

export interface TrayController {
  /** Live Tray instance — exposed so main.ts can hand it to the
   *  BadgeManager (which needs to overlay a count badge on the icon). */
  readonly tray: Tray;
  /** Rebuild the tray menu/tooltip with the current i18n language. Called
   *  from main.ts when the renderer dispatches `ccsm:set-language`. */
  applyLocale: () => void;
}

/** Bring the main window to the foreground from the tray click handler.
 *  Spawns a new window if every BrowserWindow has been destroyed. */
function showTrayWindow(deps: TrayDeps): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    deps.createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Create (or no-op return) the singleton tray. Idempotent across calls
 *  inside the same process — Electron only allows one Tray per icon path
 *  in practice, and the renderer's `ccsm:set-language` re-entry must NOT
 *  spawn a second one. */
export function createTray(deps: TrayDeps): TrayController {
  const tray = new Tray(buildTrayIcon());
  const onClick = () => showTrayWindow(deps);
  tray.on('click', onClick);
  tray.on('double-click', onClick);

  const applyLocale = () => {
    // Local require keeps the import graph linear (matches the pattern
    // main.ts uses elsewhere — see the longer comment near the
    // `ccsm:set-language` handler in main.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const i18n = require('../i18n') as typeof import('../i18n');
    tray.setToolTip(i18n.tTray('tooltip'));
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: i18n.tTray('show'), click: () => showTrayWindow(deps) },
        { type: 'separator' },
        {
          label: i18n.tTray('quit'),
          click: () => {
            deps.setIsQuitting(true);
            app.quit();
          },
        },
      ]),
    );
  };

  applyLocale();
  return { tray, applyLocale };
}
