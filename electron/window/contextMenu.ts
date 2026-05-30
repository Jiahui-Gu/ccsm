import { BrowserWindow, Menu, type MenuItemConstructorOptions, type IpcMain } from 'electron';

// One-shot suppression deadline for the native context menu. The terminal
// pane fires `shell:suppressContextMenuOnce` from its renderer-side
// `onContextMenu` handler immediately before calling `preventDefault()`;
// Electron's `webContents.on('context-menu')` then fires regardless (DOM
// preventDefault does NOT cancel the main-process event) and the listener
// installed by `installContextMenu` consults this deadline to decide
// whether to show the native menu or step aside.
//
// Module-scope (process-wide) because:
//  * the IPC channel is one-way `send`, no per-window routing payload —
//    keeping it process-wide matches the wire contract;
//  * ccsm is a single-window app in practice; the BrowserWindow that
//    fires `context-menu` is always the same one that just sent the
//    suppress. 100ms is generous enough to absorb IPC latency on slow
//    machines without suppressing a deliberate right-click ~100ms later.
const SUPPRESS_CONTEXT_MENU_WINDOW_MS = 100;
let contextMenuSuppressedUntilMs = 0;

/** Pure decider — extracted for unit test. Returns true iff `nowMs` is
 *  strictly before `deadlineMs`. */
export function isContextMenuSuppressed(
  deadlineMs: number,
  nowMs: number,
): boolean {
  return nowMs < deadlineMs;
}

/** Record a fresh one-shot suppression starting at `nowMs`. Exported so the
 *  IPC handler in `installContextMenuSuppressIpc` can be unit-tested
 *  without reaching into module state. Returns the new deadline ms. */
export function recordContextMenuSuppression(nowMs: number): number {
  contextMenuSuppressedUntilMs = nowMs + SUPPRESS_CONTEXT_MENU_WINDOW_MS;
  return contextMenuSuppressedUntilMs;
}

/** Test-only — reset suppression deadline so tests start from a clean
 *  baseline. */
export function __resetContextMenuSuppressionForTests(): void {
  contextMenuSuppressedUntilMs = 0;
}

let suppressIpcRegistered = false;

/** Register the one-shot suppression IPC handler. Idempotent — safe to call
 *  more than once (subsequent registrations are no-ops). Called from the
 *  `app.whenReady()` IPC wiring site, NOT from `createWindow`, because the
 *  channel is process-wide rather than per-window. */
export function installContextMenuSuppressIpc(ipcMain: IpcMain): void {
  if (suppressIpcRegistered) return;
  suppressIpcRegistered = true;
  ipcMain.on('shell:suppressContextMenuOnce', () => {
    recordContextMenuSuppression(Date.now());
  });
}

/** Test-only — undo `installContextMenuSuppressIpc` so a fresh test can
 *  re-register the handler against a fresh mock ipcMain. */
export function __resetSuppressIpcForTests(): void {
  suppressIpcRegistered = false;
}

// Right-click context menu for the renderer — Copy/Cut/Paste/Select All,
// contextually enabled based on selection + editable state. Attached per
// window in createWindow().
//
// The terminal pane handles its own right-click in the renderer (immediate
// copy-on-selection / paste-on-empty, no popover) and asks main to skip
// the native menu via `shell:suppressContextMenuOnce` immediately before
// returning from its onContextMenu handler. Electron fires `context-menu`
// on the WebContents regardless of DOM `preventDefault`, so the
// suppression deadline is the only way to inhibit it from main.
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, params) => {
    if (isContextMenuSuppressed(contextMenuSuppressedUntilMs, Date.now())) {
      // Consume the one-shot — subsequent right-clicks outside the
      // terminal pane (which never sends `suppressContextMenuOnce`) get
      // the native menu as normal.
      contextMenuSuppressedUntilMs = 0;
      return;
    }
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
