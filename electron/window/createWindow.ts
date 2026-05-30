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

import { BrowserWindow, app, type IpcMain } from 'electron';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { buildAppIcon } from '../branding/icon';
import { getCloseAction, setCloseAction } from '../prefs/closeAction';
import { tCloseDialog } from '../i18n';
import { WINDOW_CHANNELS } from '../shared/ipcChannels';
import { installCsp, isAllowedNavigation } from './csp';
import { installContextMenu } from './contextMenu';
import {
  type CloseDialogChoice,
  type CloseDialogResponse,
  decideCloseAction,
  CLOSE_ASK_TIMEOUT_MS,
} from './closeDialog';

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
  /** Shared `ipcMain`. createWindow registers the `window:resolveCloseAction`
   *  handler here so the renderer's in-app close dialog can route its
   *  choice back to the window that asked. Same instance the rest of
   *  electron/ipc/* uses. */
  ipcMain: IpcMain;
}

export function createWindow(deps: CreateWindowDeps): BrowserWindow {
  // Defense-in-depth: install the Content-Security-Policy response-header
  // hook on the shared default session before the window loads its URL/file
  // (DEBT.md #17). Idempotent — safe across macOS dock-activate re-creates.
  installCsp(deps.isDev);
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
  //
  // Belt-and-braces: also auto-enable hidden mode when Chromium's
  // `--enable-automation` switch is present. Playwright's
  // `_electron.launch` (which drives every harness/dogfood/screenshot
  // script in this repo) injects this switch unconditionally; same
  // for puppeteer / chromedriver / selenium. This means a dogfood
  // script that forgets to set CCSM_E2E_HIDDEN=1 STILL gets a
  // hidden window instead of popping a visible one on the dev's
  // desktop. Production launches (electron-builder packaged app,
  // `npm run dev`) never set this switch, so they're unaffected.
  // Explicit `CCSM_E2E_VISIBLE=1` opts out (for manual driving of
  // a Playwright session you want to actually watch — e.g. recording
  // a demo). Explicit `CCSM_E2E_HIDDEN=0` also opts out and takes
  // precedence over the automation auto-detect, matching the
  // existing semantics callers like harness-dnd.mjs rely on.
  const explicitHidden = process.env.CCSM_E2E_HIDDEN;
  const wantsVisible =
    process.env.CCSM_E2E_VISIBLE === '1' || explicitHidden === '0';
  const automationDriven =
    !!app.commandLine && app.commandLine.hasSwitch('enable-automation');
  const hiddenForE2E =
    !wantsVisible && (explicitHidden === '1' || automationDriven);
  // Dev runs (`npm run dev` → scripts/dev-electron.mjs sets CCSM_DEV=1)
  // share the CCSM.exe / electron.exe binary name with the installed
  // build, which made it impossible to tell them apart in tasklist or
  // Alt-Tab. Window title is the cheapest user-facing signal: Windows
  // surfaces it in the taskbar tooltip and the Alt-Tab thumbnail.
  // Packaged-dev variant (productName "CCSM Dev") and the unpackaged
  // npm-run-dev case both get the marker; the installed prod build
  // has a clean "CCSM" title.
  const isDevProcess =
    process.env.CCSM_DEV === '1' || app.getName().includes('Dev');
  const win = new BrowserWindow({
    title: isDevProcess ? 'CCSM [dev]' : 'CCSM',
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
    // macOS: hiddenInset titlebar with native traffic lights.
    // Windows: fully frameless — we self-draw the three controls inside
    //   the right pane (see WindowControls).
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 14 },
        }
      : { titleBarStyle: 'hidden' as const, frame: false }),
    // Windows 11: ask DWM to round the outer corners so the window edge
    //   matches the radii of our internal panels. Without this the window
    //   is a sharp rectangle and rounded interior surfaces look clipped
    //   where they meet it. Ignored on <Win11.
    roundedCorners: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
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
      // sandbox:true is the recommended Electron baseline (forces the
      // preload into a Chromium sandbox where Node built-ins are
      // unavailable), but our preload's `require('@sentry/electron/preload')`
      // can't be resolved by the sandboxed preload's restricted require —
      // it only follows relative paths and a small whitelist. Enabling it
      // results in: "Error: module not found: @sentry/electron/preload"
      // and `window.ccsm` is never installed.
      //
      // Followup: bundle preload through webpack (or vendor the sentry
      // preload into electron/) so the require resolves at build time, then
      // flip this back to true. Tracked separately to keep this PR scoped
      // to the IPC hardening fixes that don't require a build-pipeline
      // change.
      sandbox: false,
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
    },
  });

  win.setMenuBarVisibility(false);

  // Block the renderer from spawning new BrowserWindows. We have no use
  // case for window.open(); a successful call would create a popup with
  // our preload attached.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Keep the dev marker visible in the OS title. Electron mirrors the
  // renderer's `document.title` (`src/index.html` has `<title>CCSM</title>`)
  // into BrowserWindow.getTitle() via the default page-title-updated
  // handler — that would clobber the constructor-time "CCSM [dev]" within
  // milliseconds of dom-ready. preventDefault keeps our marker authoritative.
  // Prod builds want the renderer-driven title (future per-session titles,
  // etc.) so we gate this on the dev flag.
  if (isDevProcess) {
    win.on('page-title-updated', (event) => event.preventDefault());
  }

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
  win.on('show', () => {
    // Reset the renderer's fade-opacity in case the window was just
    // restored after a fade-to-hide (see `window:beforeHide` below).
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(WINDOW_CHANNELS.afterShow);
    }
  });

  win.on('focus', () => {
    deps.onFocusChange({ focused: true, activeSid: deps.getActiveSid() });
  });

  const emitMax = () =>
    win.webContents.send(WINDOW_CHANNELS.maximizedChanged, win.isMaximized());
  win.on('maximize', emitMax);
  win.on('unmaximize', emitMax);

  // Close-button behaviour. Three modes — see getCloseAction() above:
  //   'quit' → don't preventDefault; let the window close, fall through to
  //            window-all-closed → before-quit → app exit.
  //   'tray' → preventDefault + fade-to-hide (the original behaviour).
  //   'ask'  → preventDefault + in-app modal (rendered by the renderer's
  //            CloseActionDialog) over IPC. The user picks tray / quit /
  //            cancel + optional "Don't ask again"; renderer answers via
  //            `window:resolveCloseAction`. Replaces the ugly native
  //            `dialog.showMessageBox` (#1253).
  // The `isQuitting` short-circuit at the top stays so explicit quit paths
  // (tray menu Quit, app.before-quit safety net, electron-builder updater)
  // bypass everything.
  //
  // Fade-to-hide: before actually calling `win.hide()` we send a
  // `window:beforeHide` event so the renderer can run a short opacity
  // fade-out. `HIDE_FADE_MS` matches `DURATION.standard` (180ms) from the
  // shared motion tokens — kept short so closing still feels responsive.
  // Guarded by `fadePending` so repeated Ctrl+W presses don't stack timers.
  const HIDE_FADE_MS = 180;
  let fadePending = false;
  const fadeThenHide = () => {
    if (fadePending) return;
    fadePending = true;
    try {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(WINDOW_CHANNELS.beforeHide, { durationMs: HIDE_FADE_MS });
      }
    } catch {
      /* renderer unreachable — fall through to immediate hide */
    }
    setTimeout(() => {
      fadePending = false;
      if (win.isDestroyed()) return;
      win.hide();
    }, HIDE_FADE_MS);
  };

  // In-flight close-ask request. While a request is pending, subsequent
  // `win.on('close')` fires are coalesced — we don't open a second dialog
  // on top of the first. Cleared on resolve / timeout / window destroy.
  let pendingAsk: {
    requestId: string;
    timer: NodeJS.Timeout;
  } | null = null;

  // Apply the renderer's decision (or the timeout fallback). Centralised
  // so the IPC handler and the timeout path share one branching tree.
  const applyCloseDecision = (response: CloseDialogResponse) => {
    const decision = decideCloseAction(response);
    if (decision.persist) setCloseAction(decision.persist);
    if (decision.action === 'tray') {
      fadeThenHide();
      return;
    }
    if (decision.action === 'quit') {
      deps.setIsQuitting(true);
      app.quit();
      return;
    }
    // 'cancel' — nothing to do. The window stays open because
    // `e.preventDefault()` already ran.
  };

  // Renderer reply handler. Registered once per window; the requestId in
  // the payload pairs it with the in-flight request so stale replies from
  // a previous (timed-out) ask are ignored.
  const resolveHandler = (
    _e: unknown,
    payload: { requestId: string; choice: CloseDialogChoice; dontAskAgain: boolean },
  ) => {
    if (!pendingAsk || pendingAsk.requestId !== payload.requestId) return;
    clearTimeout(pendingAsk.timer);
    pendingAsk = null;
    applyCloseDecision({ choice: payload.choice, dontAskAgain: payload.dontAskAgain });
  };
  deps.ipcMain.on(WINDOW_CHANNELS.resolveCloseAction, resolveHandler);
  win.on('closed', () => {
    deps.ipcMain.removeListener(WINDOW_CHANNELS.resolveCloseAction, resolveHandler);
    if (pendingAsk) {
      clearTimeout(pendingAsk.timer);
      pendingAsk = null;
    }
  });

  win.on('close', (e) => {
    if (deps.getIsQuitting()) return;
    // Dev-loop escape hatch (Task #11): `scripts/dev-electron.mjs` sets
    // CCSM_DEV_QUIT_ON_CLOSE=1 so closing the window during `npm run dev`
    // fully quits the app instead of going tray-resident. Without this,
    // the Electron main proc lingered in the tray AND its sibling
    // webpack-dev-server (concurrently `dev:web`, port 4100) kept
    // running because concurrently's `-k` only reaps when one child
    // exits — every restart needed a manual taskkill. Scoped to the dev
    // wrapper's env so production, manual `electron .`, and e2e probes
    // still get the real close-to-tray choreography below.
    if (process.env.CCSM_DEV_QUIT_ON_CLOSE === '1') {
      deps.setIsQuitting(true);
      return;
    }
    const pref = getCloseAction();
    if (pref === 'quit') {
      deps.setIsQuitting(true);
      return;
    }
    e.preventDefault();
    if (pref === 'tray') {
      fadeThenHide();
      return;
    }
    // pref === 'ask': open the in-app dialog over IPC. If a request is
    // already in flight, coalesce — don't stack dialogs.
    if (pendingAsk) return;
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (!pendingAsk || pendingAsk.requestId !== requestId) return;
      pendingAsk = null;
      console.warn(
        '[main] close-action dialog timed out; falling back to tray',
      );
      applyCloseDecision({ choice: 'tray', dontAskAgain: false });
    }, CLOSE_ASK_TIMEOUT_MS);
    pendingAsk = { requestId, timer };
    try {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(WINDOW_CHANNELS.askCloseAction, {
          requestId,
          labels: {
            message: tCloseDialog('message'),
            detail: tCloseDialog('detail'),
            tray: tCloseDialog('tray'),
            quit: tCloseDialog('quit'),
            cancel: tCloseDialog('cancel'),
            dontAskAgain: tCloseDialog('dontAskAgain'),
          },
        });
      } else {
        // Renderer is gone — fall straight to tray with no persistence.
        clearTimeout(timer);
        pendingAsk = null;
        applyCloseDecision({ choice: 'tray', dontAskAgain: false });
      }
    } catch (err) {
      clearTimeout(timer);
      pendingAsk = null;
      console.warn(
        '[main] close-action dialog send failed; falling back to tray',
        err,
      );
      applyCloseDecision({ choice: 'tray', dontAskAgain: false });
    }
  });

  // After the window is shown again (tray click, dock click on macOS) the
  // renderer's opacity may still be 0 from the previous fade-out. The
  // existing `win.on('show')` handler above dispatches `window:afterShow`
  // to reset it.

  return win;
}
