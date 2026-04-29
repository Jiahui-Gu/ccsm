// System / app-shell IPC handlers. Extracted from electron/main.ts (Task #742
// Phase B).
//
// Covers: i18n locale read/write (with menu+tray rebuild), connection probe
// (~/.claude/settings.json + ANTHROPIC_* env), models list, app version, and
// the default-model lookup used by the new-session flow.
//
// The connection surface is read-only by design — users edit
// ~/.claude/settings.json via `claude /config` or by hand. This module just
// surfaces it to the renderer so the StatusBar / Settings dialog can show
// the active connection without a CLI round-trip.

import type { IpcMain, App } from 'electron';
import { shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fromMainFrame } from '../security/ipcGuards';
import {
  listModelsFromSettings,
  readDefaultModelFromSettings,
} from '../agent/list-models-from-settings';

export interface SystemIpcDeps {
  ipcMain: IpcMain;
  app: App;
  /** Rebuild the app accelerator menu with the current locale. Called when
   *  the renderer dispatches `ccsm:set-language`. */
  applyAppMenuLocale: () => void;
  /** Rebuild the tray menu/tooltip with the current locale. Same trigger. */
  applyTrayLocale: () => void;
}

/** Pure helper: read ~/.claude/settings.json + env, return the connection
 *  view shown in the StatusBar / Settings dialog. Exported for unit tests.
 *  `settingsFile` is overridable so tests don't have to touch the real
 *  homedir file. */
export function readConnectionView(
  env: NodeJS.ProcessEnv,
  settingsFile: string = path.join(os.homedir(), '.claude', 'settings.json'),
): {
  baseUrl: string | null;
  model: string | null;
  hasAuthToken: boolean;
} {
  let settingsModel: string | null = null;
  let settingsBaseUrl: string | null = null;
  let settingsAuthToken = false;
  try {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      model?: unknown;
      env?: Record<string, unknown>;
    };
    if (typeof parsed.model === 'string') settingsModel = parsed.model;
    const sEnv =
      parsed.env && typeof parsed.env === 'object' ? parsed.env : null;
    if (sEnv) {
      if (typeof sEnv.ANTHROPIC_BASE_URL === 'string')
        settingsBaseUrl = sEnv.ANTHROPIC_BASE_URL;
      if (
        typeof sEnv.ANTHROPIC_AUTH_TOKEN === 'string' ||
        typeof sEnv.ANTHROPIC_API_KEY === 'string'
      ) {
        settingsAuthToken = true;
      }
    }
  } catch {
    // Missing / malformed — fall through to env-only view.
  }
  const baseUrl = settingsBaseUrl ?? env.ANTHROPIC_BASE_URL ?? null;
  const model = settingsModel ?? env.ANTHROPIC_MODEL ?? null;
  const hasAuthToken =
    settingsAuthToken ||
    !!env.ANTHROPIC_AUTH_TOKEN?.trim() ||
    !!env.ANTHROPIC_API_KEY?.trim();
  return { baseUrl, model, hasAuthToken };
}

/** Pure handler for `models:list`. Exported for unit testing. Returns `[]`
 *  on any error (settings.json missing/malformed, fs error) so the renderer
 *  Settings pane shows an empty model list instead of receiving an opaque
 *  IPC rejection (Electron surfaces those as "An object could not be
 *  cloned"). Audit risk #10. The renderer caller already catches and shows
 *  an empty list on rejection, so the user-visible behavior is the same;
 *  the win is a logged diagnostic in main + no bridge error in renderer
 *  console. */
export async function handleModelsList(): Promise<
  Awaited<ReturnType<typeof listModelsFromSettings>>['models']
> {
  try {
    const res = await listModelsFromSettings();
    return res.models;
  } catch (err) {
    console.error('[main] models:list failed:', err);
    return [];
  }
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

  // Connection + models IPC. Single source of truth = ~/.claude/settings.json
  // (+ ANTHROPIC_* env vars). Users edit via `claude /config` or by hand;
  // CCSM does not let them edit the connection here.
  ipcMain.handle('connection:read', () => readConnectionView(process.env));
  ipcMain.handle('connection:openSettingsFile', async (e) => {
    if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    // shell.openPath returns '' on success, error string on failure. If the
    // file does not exist, create an empty stub so the editor opens cleanly.
    if (!fs.existsSync(file)) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}\n', 'utf8');
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const result = await shell.openPath(file);
    return result === '' ? { ok: true } : { ok: false, error: result };
  });
  ipcMain.handle('models:list', handleModelsList);
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

// Module exports above are the surface; no trailing helpers.
