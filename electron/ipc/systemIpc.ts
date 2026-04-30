// System / app-shell IPC handlers. Extracted from electron/main.ts (Task #742
// Phase B).
//
// Covers: i18n locale read/write (with menu+tray rebuild), app version, and
// the default-model lookup used by the new-session flow.

import type { IpcMain, App } from 'electron';
import { readDefaultModelFromSettings } from '../agent/read-default-model';

export interface SystemIpcDeps {
  ipcMain: IpcMain;
  app: App;
  /** Rebuild the app accelerator menu with the current locale. Called when
   *  the renderer dispatches `ccsm:set-language`. */
  applyAppMenuLocale: () => void;
  /** Rebuild the tray menu/tooltip with the current locale. Same trigger. */
  applyTrayLocale: () => void;
}

export function registerSystemIpc(deps: SystemIpcDeps): void {
  const { ipcMain, app, applyAppMenuLocale, applyTrayLocale } = deps;

  // i18n: renderer mirrors the resolved UI language to main so OS
  // notifications use it. Renderer also asks main for the OS locale at
  // boot to seed the "system" preference. Local require keeps the import
  // graph linear (matches the original main.ts comment — circular ts-tree
  // edge with electron/i18n.ts otherwise).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = require('../i18n') as typeof import('../i18n');

  ipcMain.handle('ccsm:get-system-locale', () => {
    try {
      return app.getLocale();
    } catch {
      return undefined;
    }
  });
  ipcMain.on('ccsm:set-language', (_e, lang: unknown) => {
    if (lang === 'en' || lang === 'zh') {
      i18n.setMainLanguage(lang);
      // Tray menu / tooltip + app accelerator menu are built once on app
      // ready; rebuild both so a language switch from Settings is reflected
      // immediately (Edit label, tray show/quit, tooltip).
      applyTrayLocale();
      applyAppMenuLocale();
    }
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  // The new-session default model comes straight from the user's CLI
  // settings.json — same source the CLI itself reads for `--model`.
  // Replaces the old `import:topModel` frequency-vote IPC (PR #369), which
  // produced model ids that weren't always in the picker list.
  ipcMain.handle('settings:defaultModel', async () => {
    try {
      return await readDefaultModelFromSettings();
    } catch {
      return null;
    }
  });

  // Seed the active language from the OS at boot, before any window is
  // created — first notification fires with the right copy even if the
  // renderer hasn't dispatched yet.
  try {
    i18n.setMainLanguage(i18n.resolveSystemLanguage(app.getLocale()));
    // Rebuild the app menu now that the seed has flipped the active
    // language; otherwise the top-level applyAppMenuLocale() call at
    // module-load time left it stuck on English.
    applyAppMenuLocale();
  } catch {
    /* ignore — falls through to the default 'en' */
  }
}
