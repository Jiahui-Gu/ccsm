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
//
// Wave-2-C: badge state moved to the daemon (`badgeStore` in
// daemon/notify/badgeStore.ts; tray polls `/api/badge/state` every 5s).
// Polling chosen over SSE because the tray tooltip is the only consumer
// here and a 5s update cadence is well within UX tolerance (the OS native
// notification fires immediately via the renderer-side sink consumer; the
// tray badge tooltip is a passive secondary surface). The legacy
// `BadgeManager` overlay icon path was removed in W2-C — we just append
// "(N)" to the tooltip when there is unread; the OS taskbar dot/flash
// belongs to the W2-D sink consumer.

import { BrowserWindow, Menu, Tray, app } from 'electron';
import { buildTrayIcon } from '../branding/icon';
import { getDaemonPort } from '../daemon-spawner';

const BADGE_POLL_MS = 5_000;

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

  // Wave-2-C: poll daemon /api/badge/state every 5s and refresh the
  // tooltip suffix with the unread total. We don't render an overlay
  // glyph here — the renderer-side W2-D sink consumer owns the OS-visible
  // badge (setOverlayIcon / app.setBadgeCount). This poll is a passive
  // tooltip-text channel so the user can read "CCSM (3)" on hover even
  // when the renderer is hidden.
  let lastTotal = 0;
  let baseTooltip = '';
  const refreshTooltip = (): void => {
    tray.setToolTip(lastTotal > 0 ? `${baseTooltip} (${lastTotal})` : baseTooltip);
  };
  const pollBadge = async (): Promise<void> => {
    const port = getDaemonPort();
    if (port == null) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/badge/state`);
      if (!res.ok) return;
      const json = (await res.json()) as { total?: number };
      const total = typeof json.total === 'number' ? json.total : 0;
      if (total !== lastTotal) {
        lastTotal = total;
        refreshTooltip();
      }
    } catch {
      /* daemon offline / not yet bound — try again next tick */
    }
  };
  const pollHandle = setInterval(() => {
    void pollBadge();
  }, BADGE_POLL_MS);
  pollHandle.unref();

  const applyLocale = () => {
    // Local require keeps the import graph linear (matches the pattern
    // main.ts uses elsewhere — see the longer comment near the
    // `ccsm:set-language` handler in main.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const i18n = require('../i18n') as typeof import('../i18n');
    baseTooltip = i18n.tTray('tooltip');
    refreshTooltip();
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
  // Kick an initial poll without waiting for the first 5s tick so the
  // tooltip reflects badges that already accumulated before tray creation.
  void pollBadge();
  return { tray, applyLocale };
}
