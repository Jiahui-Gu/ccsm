// Utility IPC handlers. Extracted from electron/main.ts (Task #742 Phase B).
//
// "Utility" = the leftover handlers that don't fit a single domain bucket:
//   * import:scan / import:recentCwds — CLI transcript discovery for
//     ImportDialog. Cache lives in this module so the eager-load at app
//     ready can prime it.
//   * cwd-related (app:userCwds:get/push, app:userHome, cwd:pick) — folder
//     picker + LRU for the StatusBar cwd popover.
//   * paths:exist — best-effort filesystem probe used during renderer
//     hydration to detect deleted cwds (typical worktree-cleanup victim).
//
// The cache is intentionally module-scoped so refresh-while-serving stays
// internal; main.ts only needs the `prime()` hook to kick the eager load.

import type { IpcMain } from 'electron';
import { BrowserWindow, dialog } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import {
  scanImportableSessions,
  type ScannableSession,
} from '../import-scanner';
import { getUserCwds, pushUserCwd } from '../prefs/userCwds';
import { isSafePath, resolveCwd, fromMainFrame } from '../security/ipcGuards';

export interface UtilityIpcDeps {
  ipcMain: IpcMain;
}

// The CLI transcripts under ~/.claude/projects can run into hundreds of
// files; the head-parse is fast per file but the cumulative latency makes
// the ImportDialog's "Scanning…" state visible for several seconds on cold
// open. Eager-load the scan at app `ready` and serve cached results to
// renderers, refreshing in the background on each request so newly-recorded
// sessions show up without a manual reload.
let importableCache: ScannableSession[] = [];
let importablePending: Promise<ScannableSession[]> | null = null;

function refreshImportableCache(): Promise<ScannableSession[]> {
  if (importablePending) return importablePending;
  importablePending = scanImportableSessions()
    .then((rows) => {
      importableCache = rows;
      return rows;
    })
    .catch((err) => {
      console.warn('[main] scanImportableSessions failed', err);
      return importableCache;
    })
    .finally(() => {
      importablePending = null;
    }) as Promise<ScannableSession[]>;
  return importablePending;
}

async function getImportableSessions(): Promise<ScannableSession[]> {
  // Hot cache: serve instantly and refresh in the background so the next
  // call sees fresher data. Cold cache: await the in-flight (or new) scan
  // so the renderer never gets [].
  if (importableCache.length > 0) {
    void refreshImportableCache();
    return importableCache;
  }
  return refreshImportableCache();
}

/** Pure helper for `paths:exist`: takes the renderer-supplied list and
 *  returns the existence map after the safety filter (UNC + non-absolute
 *  → false to avoid the SMB/NTLM-leak class of bug). Exported for unit
 *  tests so we can exercise the safety filter without touching IPC. */
export function probePaths(inputPaths: unknown): Record<string, boolean> {
  const list = Array.isArray(inputPaths)
    ? inputPaths.filter((p): p is string => typeof p === 'string')
    : [];
  const out: Record<string, boolean> = {};
  for (const p of list) {
    // Reject UNC + non-absolute paths BEFORE touching fs. On Windows,
    // `fs.existsSync('\\\\server\\share\\probe')` triggers an SMB lookup
    // and leaks the user's NTLM hash to the named host. Map any unsafe
    // path to `false` so the renderer's hydration migration treats it as
    // "missing cwd" — exactly the desired behaviour. resolveCwd is still
    // applied so `~`-prefixed cwds are expanded before the safety check.
    try {
      const resolved = resolveCwd(p);
      if (!isSafePath(resolved)) {
        out[p] = false;
        continue;
      }
      out[p] = fs.existsSync(resolved);
    } catch {
      out[p] = false;
    }
  }
  return out;
}

/** Kick the eager scan from main.ts at app ready so ImportDialog sees data
 *  the moment the user opens it. Fire-and-forget; the cache logs its own
 *  errors and stores [] on failure so the dialog gracefully degrades. */
export function primeImportableCache(): void {
  void refreshImportableCache();
}

export function registerUtilityIpc(deps: UtilityIpcDeps): void {
  const { ipcMain } = deps;

  ipcMain.handle('import:scan', () => getImportableSessions());
  // Recent cwd list shown in the StatusBar cwd popover. Sourced from the
  // ccsm-owned LRU (NOT from CLI JSONL scans). Always includes home as a
  // fallback so the list is never empty.
  ipcMain.handle('import:recentCwds', () => getUserCwds());
  ipcMain.handle('app:userCwds:get', () => getUserCwds());
  ipcMain.handle('app:userCwds:push', (e, p: unknown) => {
    if (!fromMainFrame(e)) return getUserCwds();
    if (typeof p !== 'string') return getUserCwds();
    // Security gate (#804 risk #4): the LRU here feeds the cwd popover and
    // is later replayed into `pty:spawn`. A single hostile push would
    // persist a UNC trap path that statSync's later — see resolveSpawnCwd.
    // Drop unsafe entries (UNC / relative / non-absolute) at the boundary
    // so they never reach disk.
    if (!isSafePath(p)) {
      console.warn(
        `[main] app:userCwds:push rejected unsafe path ${JSON.stringify(p)}`,
      );
      return getUserCwds();
    }
    return pushUserCwd(p);
  });
  ipcMain.handle('app:userHome', () => os.homedir());

  // OS folder picker for the cwd popover's "Browse..." button. Returns the
  // chosen absolute path on success, or null when the user cancelled or no
  // window is available. Anchored on the requesting BrowserWindow so the
  // dialog is modal to the right surface (relevant when devtools are popped
  // out into their own window). Bug #628: prior to this handler the Browse
  // button was a no-op (just closed the popover) and users picking a cwd
  // via Browse silently fell through to the LRU/home default — matching
  // the dogfood report "在特定目录创建session，创建出来的session仍然在home目录".
  ipcMain.handle('cwd:pick', async (e, opts?: { defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return null;
    const defaultPath =
      typeof opts?.defaultPath === 'string' && opts.defaultPath.length > 0
        ? opts.defaultPath
        : os.homedir();
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Pick working directory',
        defaultPath,
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
      if (result.canceled) return null;
      const picked = result.filePaths[0];
      return typeof picked === 'string' && picked.length > 0 ? picked : null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('paths:exist', (_e, inputPaths: unknown) =>
    // Batched best-effort existence probe for arbitrary filesystem paths.
    // The renderer uses this on hydration to flag sessions whose persisted
    // `cwd` was deleted between runs (typical worktree-cleanup victim — see
    // PR #104). Returned map is keyed by the input path; missing paths and
    // permission errors both map to `false` (we don't surface the
    // distinction — for the migration's purpose they're equivalent: don't
    // auto-spawn).
    probePaths(inputPaths),
  );
}
