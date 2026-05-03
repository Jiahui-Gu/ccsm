// electron/ipc-allowlisted/folder-picker.ts
//
// Native folder-picker IPC channel — `cwd:pick`. Per spec ch08 §3.1
// (`.no-ipc-allowlist` contract), this is one of the v0.3 sanctioned
// `ipcMain.handle` channels exempt from `lint:no-ipc` (ship-gate (a)):
// the OS folder dialog has no daemon equivalent and no browser API
// substitute (v0.4 web client substitutes a typed text field with
// autocomplete per spec table row at line 2119).
//
// Contract — matches the renderer's `window.ccsm.pickCwd(defaultPath?)`
// declaration in `src/global.d.ts`:
//   * Returns the picked absolute path on success.
//   * Returns `null` when the user cancels (cancellation is NOT an error).
//   * Falls back to `app.getPath('home')` when `defaultPath` is undefined
//     so the dialog opens at a useful location on the user's first pick.
//
// SRP: producer/decider/sink shape — this module is a SINK (one side
// effect: opening the OS folder dialog) wired to a single producer (the
// renderer's `cwd:pick` invoke). No business logic, no decisions, no
// fan-out.
//
// Allowlist: this file is enumerated in `tools/.no-ipc-allowlist` and is
// the ONLY non-test consumer of `ipcMain` for the `cwd:pick` channel.
// Adding a sibling handler in this file requires a §3.1 amendment.

import { app, dialog, ipcMain } from 'electron';

const CHANNEL = 'cwd:pick';

let registered = false;

/**
 * Register the `cwd:pick` IPC handler. Idempotent — calling twice is a
 * no-op so module-graph re-imports during HMR don't double-register.
 */
export function registerFolderPickerIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    CHANNEL,
    async (_event, defaultPath?: string): Promise<string | null> => {
      const startPath =
        typeof defaultPath === 'string' && defaultPath.length > 0
          ? defaultPath
          : app.getPath('home');
      const result = await dialog.showOpenDialog({
        defaultPath: startPath,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const picked = result.filePaths[0];
      return typeof picked === 'string' ? picked : null;
    },
  );
}

/** Test seam: drop the handler registration so re-registration in unit
 *  tests doesn't throw "Attempted to register a second handler". */
export function __resetFolderPickerForTests(): void {
  if (!registered) return;
  ipcMain.removeHandler(CHANNEL);
  registered = false;
}
