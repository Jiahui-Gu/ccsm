// Main BrowserWindow factory + window-scoped wiring. Extracted from
// electron/main.ts (Task #731 Phase A2).
//
// Contract: behaviour is a verbatim move from main.ts. The factory takes a
// dependency bag so main.ts owns the cross-module references (close-action
// preference reads, badge controller, active-sid mirror, quitting flag) while
// this module owns the BrowserWindow instantiation, hidden-mode positioning,
// frame styling, dev-vs-prod URL, will-navigate guard, context-menu install,
// and the close → fade-to-hide / quit / ask choreography.
//
// Why a factory + deps:
//   * `isQuitting` is mutated from multiple call sites (close handler, tray
//     Quit, before-quit). The window's close handler must read the latest
//     value AND be able to flip it to true when the user picks "quit". A
//     getter/setter pair keeps the semantics identical to the previous
//     module-level `let` while letting the live value cross the module
//     boundary without a circular import.
//   * `getCloseAction` / `setCloseAction` come from electron/prefs and are
//     already independently testable; we re-import them here rather than
//     plumbing them through the bag, since they're stateless module imports.
//   * `installContextMenu` is colocated here — it's only used from
//     createWindow and has no other caller in main.ts.

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'path';
import { buildAppIcon } from '../branding/icon';
import {
  type CloseAction,
  getCloseAction,
  setCloseAction,
} from '../prefs/closeAction';

export interface CreateWindowDeps {
  /** True iff we should load the webpack-dev-server URL instead of the
   *  packaged renderer bundle. Computed by main.ts from `app.isPackaged`
   *  and the `CCSM_PROD_BUNDLE` env override. */
  isDev: boolean;
  /** Read latest active session id (mirrored from renderer) for the
   *  badge controller's focus-change updates. */
  getActiveSid: () => string | null;
  /** Notify the badge controller that focus changed. */
  onFocusChange: (info: { focused: boolean; activeSid: string | null }) => void;
  /** Read the latest `isQuitting` flag — close handler must short-circuit
   *  when an explicit quit path (tray Quit / before-quit / updater) is
   *  already in flight. */
  getIsQuitting: () => boolean;
  /** Flip `isQuitting` to true when the user picks "quit" in the
   *  close-action dialog or sets the persisted preference to 'quit'. */
  setIsQuitting: (v: boolean) => void;
}

// Pure decider for the `will-navigate` allowlist (#804 risk #7). Allows the
// env-driven dev server origin (`CCSM_DEV_PORT`, defaulting to 4100 when
// unset) and any `file:` navigation (production renderer load). The literal
// `localhost:4100` was previously allowed unconditionally in addition to the
// env-driven origin — drop the literal so a stale dev port + dev build is not
// a navigation-bypass surface. Exported for the `installContextMenu`-style
// unit test in `__tests__/createWindow.test.ts`.
export function isAllowedNavigation(
  url: string,
  envDevPort: string | undefined,
): boolean {
  try {
    const u = new URL(url);
    const devPort = envDevPort && envDevPort.length > 0 ? envDevPort : '4100';
    return u.origin === `http://localhost:${devPort}` || u.protocol === 'file:';
  } catch {
    return false;
  }
}

// Right-click context menu for the renderer — Copy/Cut/Paste/Select All,
// contextually enabled based on selection + editable state. Attached per
// window in createWindow().
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, params) => {
    const { selectionText, editFlags, isEditable } = params;
    const hasSelection = !!selectionText && selectionText.trim().length > 0;
    const items: MenuItemConstructorOptions[] = [];
    if (isEditable) {
      items.push({ role: 'cut', enabled: !!editFlags.canCut });
    }
    items.push({ role: 'copy', enabled: hasSelection && !!editFlags.canCopy });
    if (isEditable) {
      items.push({ role: 'paste', enabled: !!editFlags.canPaste });
    }
    items.push(
      { type: 'separator' },
      { role: 'selectAll', enabled: !!editFlags.canSelectAll },
    );
    const menu = Menu.buildFromTemplate(items);
    menu.popup({ window: win });
  });
}

export function createWindow(deps: CreateWindowDeps): BrowserWindow {
  // E2E hidden mode: when CCSM_E2E_HIDDEN=1 the window is created
  // at position (-32000, -32000) — far outside any monitor's visible
  // area on every common multi-monitor layout. The window IS shown
  // (show:true) so Chromium runs at full speed: rAF at 60Hz (no
  // background throttling), full layout/paint, focus delivery, and
  // CSS transitions all behave identically to a normal visible
  // window. Probes that exercise hover / drag / autoFocus / drop
  // animations all pass without per-probe opt-outs.
  //
  // Why not show:false: Chromium aggressively throttles offscreen
  // renderers down to ~1Hz rAF even with paintWhenInitiallyHidden
  // and webContents.setBackgroundThrottling(false). dnd-kit's
  // 150ms dropAnimation never completes; the DragOverlay sticks
  // in the DOM after pointerup; subsequent drags hit the orphaned
  // overlay instead of their real target. Off-screen-positioned
  // windows ARE Chromium-visible and therefore fully active.
  //
  // Devs running a single probe by hand without the env still get
  // a normal centered visible window for debugging.
  const hiddenForE2E = process.env.CCSM_E2E_HIDDEN === '1';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    x: hiddenForE2E ? -32000 : undefined,
    y: hiddenForE2E ? -32000 : undefined,
    show: true,
    // Hide from Windows taskbar / Alt-Tab when running e2e so the
    // user can't see a "ccsm" entry while a probe batch is in
    // flight. Doesn't affect Chromium's "is the window active"
    // signal, so rAF / focus / animations stay un-throttled.
    skipTaskbar: hiddenForE2E,
    // Brand icon for the Windows taskbar / Alt-Tab thumbnail / window-switcher
    // preview. Matches the system tray icon (electron/branding/icon.ts) so the
    // taskbar entry, tray entry, and installer (build/icon.ico) all show the
    // same "C" mark. #630 — without this, Windows falls back to the default
    // Electron atom logo when CCSM is run unpackaged in dev, and the packaged
    // build's window icon disagrees with the tray icon on some systems.
    // Multi-resolution NativeImage so Windows picks the right pixel size for
    // the surface it's rendering.
    icon: buildAppIcon(),
    // Solid app background — we deliver depth via layered surfaces in CSS,
    // not via Mica/transparency. The user explicitly does not want to see
    // the desktop through the window.
    backgroundColor: '#0B0B0C',
    // Wave 0c (#217): frameless DISABLED for v0.3 — use the OS-default
    // window chrome (title bar, resize handles, traffic lights / minimize-
    // maximize-close controls). v0.2's self-drawn title bar relied on the
    // preload IPC bridge to read maximize state and dispatch window
    // commands; with the bridge gone we revert to native chrome rather
    // than ship a half-wired custom one. Custom chrome may return in v0.4
    // once the daemon-driven RPC layer can carry window-control intents.
    // Windows 11: ask DWM to round the outer corners so the window edge
    //   matches the radii of our internal panels. Without this the window
    //   is a sharp rectangle and rounded interior surfaces look clipped
    //   where they meet it. Ignored on <Win11.
    roundedCorners: true,
    autoHideMenuBar: true,
    webPreferences: {
      // sandbox:true is the recommended Electron baseline. Wave 0b (#216)
      // removed the preload, so there is no longer a sandboxed-require
      // mismatch to worry about — flip it on.
      sandbox: true,
      // Hidden-mode animation correctness: Chromium throttles rAF
      // for offscreen / hidden windows down to ~1Hz. dnd-kit's
      // dropAnimation (150ms) and other CSS transitions then never
      // complete, the DragOverlay element stays in the DOM after
      // pointerup, and subsequent drags hit the leftover overlay
      // instead of their real target. backgroundThrottling:false
      // forces Chromium to run rAF at full speed even when the
      // BrowserWindow is hidden.
      backgroundThrottling: false,
      // CCSM_E2E_HIDDEN=1 also strips the DevTools surface entirely so
      // probes cannot accidentally pop a DevTools window (any explicit
      // openDevTools() call below is a no-op once this is false).
      devTools: !hiddenForE2E,
    },
  });

  win.setMenuBarVisibility(false);

  // Block the renderer from spawning new BrowserWindows. We have no use
  // case for window.open(); a successful call would create a popup with
  // our preload attached.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Block in-window navigation away from our renderer origin. The renderer
  // should never navigate; all external links go through `shell:openExternal`
  // (which itself filters to http(s) only).
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, process.env.CCSM_DEV_PORT)) {
      event.preventDefault();
    }
  });

  if (deps.isDev) {
    const port = process.env.CCSM_DEV_PORT || '4100';
    win.loadURL(`http://localhost:${port}`);
    if (!hiddenForE2E) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  }

  // Hidden-mode focus priming: a window with show:false never receives
  // OS focus, so document.hasFocus() in the renderer would stay false
  // and autoFocus on freshly-mounted alertdialog buttons would no-op.
  // Calling webContents.focus() sets Chromium-level focus on the
  // renderer regardless of the OS surface state — the renderer then
  // observes focused === true and autoFocus / focus-trap behaviors
  // match a normal visible window. We also disable background
  // throttling at the webContents level (belt-and-suspenders alongside
  // webPreferences.backgroundThrottling:false above) so rAF runs at
  // full speed and CSS transitions / dnd-kit drop animations complete.
  if (hiddenForE2E) {
    try {
      win.webContents.focus();
    } catch {
      /* ignore */
    }
    try {
      win.webContents.setBackgroundThrottling(false);
    } catch {
      /* ignore */
    }
  }
  installContextMenu(win);

  // Window-level lifecycle bookkeeping. (The pre-PR-8 ttyd-exit fan-out
  // bound a renderer here via `bindCliBridgeSender`; ptyHost now reaches
  // attached webContents directly through their per-session attach map,
  // so no explicit binding step is needed.)
  //
  // Wave 0c (#217): the `window:afterShow` and `window:maximizedChanged`
  // renderer broadcasts are gone — there is no preload bridge to receive
  // them. Native chrome means the renderer doesn't need to draw its own
  // maximize affordance, and the fade-on-restore animation is dropped
  // alongside the fade-on-hide (see fadeThenHide below).

  win.on('focus', () => {
    deps.onFocusChange({ focused: true, activeSid: deps.getActiveSid() });
  });

  // Close-button behaviour. Three modes — see getCloseAction() above:
  //   'quit' → don't preventDefault; let the window close, fall through to
  //            window-all-closed → before-quit → app exit.
  //   'tray' → preventDefault + hide (the original behaviour, minus the
  //            fade now that we can no longer cue the renderer).
  //   'ask'  → preventDefault + native dialog with a "Don't ask again"
  //            checkbox; on confirm we persist the choice via setCloseAction
  //            so the next click goes straight to that branch.
  // The `isQuitting` short-circuit at the top stays so explicit quit paths
  // (tray menu Quit, app.before-quit safety net, electron-builder updater)
  // bypass everything.
  //
  // Wave 0c (#217): the renderer-side fade-out animation is removed because
  // we no longer have a `window:beforeHide` IPC channel to start it. We hide
  // immediately instead. v0.4 will reintroduce the cue over the daemon RPC.
  win.on('close', (e) => {
    if (deps.getIsQuitting()) return;
    const pref = getCloseAction();
    if (pref === 'quit') {
      deps.setIsQuitting(true);
      return;
    }
    e.preventDefault();
    if (pref === 'tray') {
      win.hide();
      return;
    }
    // pref === 'ask': prompt once. Showing the dialog is async, but
    // preventDefault has already kept the window alive; we run the dialog
    // and act on the user's choice in the resolved promise.
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const i18n = require('../i18n') as typeof import('../i18n');
      let result: { response: number; checkboxChecked: boolean };
      try {
        result = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: [i18n.tCloseDialog('tray'), i18n.tCloseDialog('quit')],
          defaultId: 0,
          cancelId: 0,
          message: i18n.tCloseDialog('message'),
          detail: i18n.tCloseDialog('detail'),
          checkboxLabel: i18n.tCloseDialog('dontAskAgain'),
          checkboxChecked: false,
        });
      } catch (err) {
        console.warn(
          '[main] close-action dialog failed; falling back to tray',
          err,
        );
        win.hide();
        return;
      }
      const choice: CloseAction = result.response === 0 ? 'tray' : 'quit';
      if (result.checkboxChecked) setCloseAction(choice);
      if (choice === 'tray') {
        win.hide();
      } else {
        deps.setIsQuitting(true);
        app.quit();
      }
    })();
  });

  return win;
}
