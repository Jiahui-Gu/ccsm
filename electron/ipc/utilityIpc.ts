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
import { BrowserWindow, dialog, shell } from 'electron';
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
// open. Eager-load the scan at app `ready` via `primeImportableCache()` so
// the first user open just awaits the already-resolved priming promise;
// subsequent opens always await a fresh scan so newly-recorded sessions
// show up without a manual reload (bug: stale list on second open).
//
// `importablePending` is a single-flight mutex: concurrent IPCs share the
// in-flight scan rather than each triggering their own filesystem walk.
let importableCache: ScannableSession[] = [];
let importablePending: Promise<ScannableSession[]> | null = null;

// Defensive ceilings (DEBT #12). These handlers returned/consumed unbounded
// arrays and could ship an arbitrarily large payload over IPC.
//
// The two caps bound different things:
//   • MAX_IMPORT_SESSIONS caps the IPC *payload* only. The upstream scan
//     (scanImportableSessions) still walks the whole `~/.claude/projects`
//     tree — this cap does not bound that work, it just refuses to serialize
//     a pathological result set across the bridge.
//   • MAX_PROBE_PATHS caps the *work*: paths:exist slices before the
//     fs.existsSync loop, so the cap genuinely bounds the syscalls, not just
//     the returned map.
//
// Both ceilings sit far above any realistic user (2000 importable sessions,
// 5000 cwd probes) so a real workload never truncates; they exist only to
// bound a pathological or hostile input. Truncation is silent-with-a-warn —
// every consumer treats a shorter list as "fewer items", never as an error
// (an absent cwd in the paths:exist map is read as undefined, i.e. left
// un-flagged, not "missing").
const MAX_IMPORT_SESSIONS = 2000;
const MAX_PROBE_PATHS = 5000;

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
  // Always await a fresh scan. Concurrent callers share the in-flight
  // promise via `importablePending` so opening the dialog never double-
  // scans. Cold-open latency is mitigated by `primeImportableCache()`
  // running at app `ready`: by the time the user opens the dialog the
  // priming scan has typically already resolved.
  const rows = await refreshImportableCache();
  // Payload cap only — the scan above already walked the full tree; this just
  // bounds what we serialize across the IPC bridge. See MAX_IMPORT_SESSIONS.
  if (rows.length > MAX_IMPORT_SESSIONS) {
    console.warn(
      `[main] import:scan truncated ${rows.length} → ${MAX_IMPORT_SESSIONS} sessions`,
    );
    return rows.slice(0, MAX_IMPORT_SESSIONS);
  }
  return rows;
}

/** Pure helper for `paths:exist`: takes the renderer-supplied list and
 *  returns the existence map after the safety filter (UNC + non-absolute
 *  → false to avoid the SMB/NTLM-leak class of bug). Exported for unit
 *  tests so we can exercise the safety filter without touching IPC. */
export function probePaths(inputPaths: unknown): Record<string, boolean> {
  const all = Array.isArray(inputPaths)
    ? inputPaths.filter((p): p is string => typeof p === 'string')
    : [];
  let list = all;
  if (all.length > MAX_PROBE_PATHS) {
    console.warn(
      `[main] paths:exist truncated ${all.length} → ${MAX_PROBE_PATHS} probes`,
    );
    list = all.slice(0, MAX_PROBE_PATHS);
  }
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

/**
 * Scheme whitelist for `ccsm:openExternal`. Renderer feeds URIs detected
 * by xterm's WebLinksAddon — i.e. arbitrary strings printed by whatever
 * the PTY is running. The IPC handler MUST refuse anything outside
 * `http://` / `https://` so a malicious TUI cannot trick the user's
 * Ctrl/Cmd-click into launching `file://`, `javascript:`, `data:`,
 * `vbscript:` (or any other shell-handled scheme) via `shell.openExternal`.
 *
 * Exported for direct unit testing so the security gate is exercised
 * without spinning up the IPC layer or mocking `electron.shell`.
 */
export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  return /^https?:\/\//i.test(url);
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
    //
    // Mirror `probePaths`: expand `~`/`~/foo` to an absolute home path with
    // resolveCwd BEFORE isSafePath, then persist the RESOLVED path. Without
    // this a tilde cwd is silently rejected by isSafePath (a bare `~` is not
    // an absolute path) and the user's recent-cwd never gets recorded. The
    // resolveCwd→isSafePath ordering is load-bearing: isSafePath MUST run on
    // the resolved path before any fs access (UNC/NTLM-leak defense).
    const resolved = resolveCwd(p);
    if (!isSafePath(resolved)) {
      console.warn(
        `[main] app:userCwds:push rejected unsafe path ${JSON.stringify(p)}`,
      );
      return getUserCwds();
    }
    return pushUserCwd(resolved);
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

  // Ctrl/Cmd-click handoff from xterm's WebLinksAddon to the OS browser.
  // Background: the renderer's BrowserWindow has `setWindowOpenHandler`
  // returning `{action:'deny'}` (see electron/window/createWindow.ts), so
  // a plain `window.open(uri)` — WebLinksAddon's default — is silently
  // dropped. The renderer now gates on modifier key and routes through
  // this channel; we still apply a strict scheme whitelist here because
  // the URI originates from arbitrary PTY output and IPC payloads are
  // untrusted by definition. Anything outside http(s) (file://, javascript:,
  // data:, vbscript:, custom protocol handlers, ...) is rejected before
  // touching `shell.openExternal`.
  ipcMain.handle('ccsm:openExternal', async (_e, url: unknown) => {
    if (!isAllowedExternalUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch (err) {
      console.warn('[main] ccsm:openExternal failed', err);
      return false;
    }
  });
}
