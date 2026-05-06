// Hard-fail startup screen — Task #639 (v0.3 ship-blocker).
//
// When the daemon child process exits non-zero before printing PORT
// (i.e. a critical startup module like initDb threw — see
// daemon/startup/data.ts and daemon/startup/index.ts), spawnDaemon's
// promise rejects with DaemonHardFailError. electron/main.ts catches
// that and calls createHardFailScreen instead of createWindow.
//
// The whole point: NEVER let the user reach the main React app when
// storage is unavailable. The dogfood-575 P0 was caused by exactly that
// — daemon emitted PORT despite initDb failing, renderer mounted, user
// created groups + sessions, every db:save silently dropped on the
// floor, restart wiped everything. The hard-fail screen is the v0.3
// invariant: PORT === all critical deps OK; absence of PORT === user
// sees a static error screen with no IPC, no group/session UI, no
// space to do work that won't persist.
//
// Implementation choices:
//   * Inline data: URL HTML so we don't depend on the renderer build
//     output (which itself depends on the daemon for hydration). The
//     screen MUST work even if dist/renderer is missing.
//   * No preload, no nodeIntegration, no contextIsolation hooks. This
//     window cannot do anything except display the message. Quit via
//     the OS close button is sufficient — there's nothing to recover
//     in-process.
//   * Same approximate footprint as the main window (1100x720) so the
//     screen feels like a normal app surface, not an alert.

import { BrowserWindow, app, type BrowserWindowConstructorOptions } from 'electron';
import { buildAppIcon } from '../branding/icon';

export interface HardFailScreenOptions {
  /** One-line summary — typically the DaemonSpawnError class name +
   *  exit code. Shown as the screen's headline. */
  reason: string;
  /** Optional multi-line detail (stderr tail from the daemon child).
   *  Rendered in a copy-friendly <pre> below the headline. */
  detail?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtml(reason: string, detail: string | undefined): string {
  const detailBlock = detail && detail.length > 0
    ? `<details open><summary>Daemon stderr (last lines)</summary><pre>${escapeHtml(detail)}</pre></details>`
    : '';
  // Single-string template, kept ASCII so it survives any encoding path.
  // Visual style mirrors the rest of the app (dark gray bg, mono detail
  // block) but is intentionally NOT pixel-perfect — this screen should
  // feel like an OS-level alert, not a polished product surface.
  const appVersion = (() => {
    try {
      return app.getVersion();
    } catch {
      return 'unknown';
    }
  })();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ccsm — startup failed</title>
  <style>
    html, body { margin: 0; height: 100%; background: #1c1f23; color: #e7e9ec; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
    main { max-width: 720px; width: 100%; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 12px; color: #ff6b6b; }
    p { font-size: 13px; line-height: 1.55; margin: 0 0 12px; color: #c8ccd1; }
    .reason { background: #2a2d33; border: 1px solid #3a3e45; border-radius: 4px; padding: 10px 12px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: #ffb4b4; word-break: break-word; }
    details { margin-top: 16px; }
    summary { cursor: pointer; font-size: 12px; color: #8b9098; user-select: none; }
    pre { background: #0f1114; border: 1px solid #3a3e45; border-radius: 4px; padding: 12px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; color: #c8ccd1; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; margin-top: 8px; }
    footer { margin-top: 20px; font-size: 11px; color: #6a6f77; }
  </style>
</head>
<body>
  <main data-testid="hard-fail-screen">
    <h1>ccsm could not start</h1>
    <p>A required component failed to initialise. The app cannot run safely until this is resolved — you may lose data if we let you continue.</p>
    <div class="reason" data-testid="hard-fail-reason">${escapeHtml(reason)}</div>
    <p>Try restarting the app. If this keeps happening, please reinstall ccsm or contact support with the details below.</p>
    ${detailBlock}
    <footer>ccsm ${escapeHtml(appVersion)}</footer>
  </main>
</body>
</html>`;
}

let hardFailWin: BrowserWindow | null = null;

/**
 * Create (or focus) the hard-fail startup screen. Idempotent — if a
 * window already exists, we update its content + focus it instead of
 * spawning a second one.
 *
 * Returns the BrowserWindow so callers (and tests) can assert on it.
 */
export function createHardFailScreen(opts: HardFailScreenOptions): BrowserWindow {
  if (hardFailWin && !hardFailWin.isDestroyed()) {
    const html = buildHtml(opts.reason, opts.detail);
    void hardFailWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    hardFailWin.focus();
    return hardFailWin;
  }

  const winOpts: BrowserWindowConstructorOptions = {
    width: 760,
    height: 520,
    title: 'ccsm — startup failed',
    backgroundColor: '#1c1f23',
    show: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      // No preload, no nodeIntegration, no contextIsolation hooks. This
      // window MUST NOT have IPC access — it exists solely to display a
      // static error and let the user close the app.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // Icon best-effort — buildAppIcon may fail in some test envs.
  try {
    const icon = buildAppIcon();
    if (icon) winOpts.icon = icon;
  } catch {
    /* best-effort */
  }

  const win = new BrowserWindow(winOpts);
  hardFailWin = win;
  win.on('closed', () => {
    if (hardFailWin === win) hardFailWin = null;
  });

  const html = buildHtml(opts.reason, opts.detail);
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // When the user closes the hard-fail screen, quit the app — there's
  // no main window to fall back to and tray-on-close semantics don't
  // apply (we never created the tray either).
  win.on('close', () => {
    try {
      app.quit();
    } catch {
      /* best-effort */
    }
  });

  return win;
}

/** Test-only: clear the singleton so unit tests can drive multiple
 *  invocations across cases. */
export function __resetForTests(): void {
  hardFailWin = null;
}
