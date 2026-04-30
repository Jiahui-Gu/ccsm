// Registers the eight `pty:*` IPC handlers + the sessionWatcher → renderer
// state/title bridge.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A) so the
// lifecycle layer (entry creation / spawn / attach / kill) is no longer
// tangled with the IPC surface. The registrar owns no state of its own
// beyond the one-shot `stateBridgeInstalled` guard.

import type { BrowserWindow, IpcMain } from 'electron';
import { resolveClaude } from './claudeResolver';
import { sessionWatcher } from '../sessionWatcher';
import type { AttachResult, PtySessionInfo } from './lifecycle';

interface SessionEntryHandle {
  pty: { pid: number };
  serialize: { serialize: () => string };
  cols: number;
  rows: number;
  attached: Map<number, Electron.WebContents>;
}

export interface PtyIpcDeps {
  getMainWindow: () => BrowserWindow | null;
  /** Direct access to the sessions map for `pty:attach` / `pty:detach` —
   *  those handlers need to mutate the per-entry `attached` map and read
   *  the headless serializer, both of which are entry-level concerns. */
  getEntry: (sid: string) => SessionEntryHandle | undefined;
  // Lifecycle ops the registrar delegates to.
  listPtySessions: () => PtySessionInfo[];
  spawnPtySession: (
    sid: string,
    cwd: string,
    claudePath: string,
    opts?: { cols?: number; rows?: number; onCwdRedirect?: (newCwd: string) => void },
  ) => PtySessionInfo;
  inputPtySession: (sid: string, data: string) => void;
  resizePtySession: (sid: string, cols: number, rows: number) => void;
  killPtySession: (sid: string) => boolean;
  getPtySession: (sid: string) => PtySessionInfo | null;
}

// Module-singleton guard: registerPtyIpc may be called more than once
// in dev/HMR; we only want one sessionWatcher → IPC bridge.
let stateBridgeInstalled = false;

export function registerPtyIpc(ipcMain: IpcMain, deps: PtyIpcDeps): void {
  const { getMainWindow } = deps;

  // Fan out sessionWatcher's state-changed events to the renderer. We send
  // to the main window (the only renderer that subscribes today); the
  // preload bridges via `window.ccsmSession.onState`. Subscribed once at
  // module init — sessionWatcher is a singleton and start/stopWatching
  // happens in spawn/kill, so we never need to teardown this listener.
  if (!stateBridgeInstalled) {
    sessionWatcher.on('state-changed', (evt) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      const wc = win.webContents;
      if (wc.isDestroyed()) return;
      try {
        wc.send('session:state', evt);
      } catch {
        /* renderer gone */
      }
    });
    // Title fan-out mirrors the state-changed bridge above. The watcher
    // emits `{sid, title}` only when the SDK-derived summary changes, so
    // there is no extra dedupe needed on this side.
    sessionWatcher.on('title-changed', (evt) => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      const wc = win.webContents;
      if (wc.isDestroyed()) return;
      try {
        wc.send('session:title', evt);
      } catch {
        /* renderer gone */
      }
    });
    stateBridgeInstalled = true;
  }

  ipcMain.handle('pty:list', () => deps.listPtySessions());

  ipcMain.handle('pty:spawn', (_event, sid: string, cwd: string, opts?: unknown) => {
    const claudePath = resolveClaude();
    if (!claudePath) {
      return { ok: false, error: 'claude_not_found' };
    }
    // Renderer-supplied initial size (Task #852). Spawning the PTY at the
    // visible viewport's dimensions (rather than the 120x30 default) means
    // claude's TUI renders its first frame — including alt-screen prompts
    // like the trust dialog — at exactly the size the visible xterm will
    // display, eliminating the "top-painted, bottom-black-void" divergence
    // caused by post-write resize. If renderer omits opts, fall back to
    // the lifecycle default.
    const cols =
      typeof opts === 'object' && opts !== null && typeof (opts as { cols?: unknown }).cols === 'number'
        ? Math.max(2, Math.floor((opts as { cols: number }).cols))
        : undefined;
    const rows =
      typeof opts === 'object' && opts !== null && typeof (opts as { rows?: unknown }).rows === 'number'
        ? Math.max(2, Math.floor((opts as { rows: number }).rows))
        : undefined;
    try {
      const info = deps.spawnPtySession(sid, cwd, claudePath, {
        cols,
        rows,
        // Import-resume cwd-redirect (#603 reviewer Layer-1 fix). When the
        // copy helper relocates the JSONL into the spawn cwd's projectDir,
        // the renderer's `session.cwd` (still pointing at the original
        // recorded cwd, possibly missing) is now stale relative to the
        // live JSONL. Push the new cwd to the renderer so the
        // sessionTitles bridge (`store.ts:renameSession` / `_backfillTitles`
        // / etc.) reads/writes the COPY, not the frozen SOURCE.
        onCwdRedirect: (newCwd: string) => {
          const win = getMainWindow();
          if (!win || win.isDestroyed()) return;
          const wc = win.webContents;
          if (wc.isDestroyed()) return;
          try {
            wc.send('session:cwdRedirected', { sid, newCwd });
          } catch {
            /* renderer gone */
          }
        },
      });
      return { ok: true, ...info };
    } catch (err) {
      return {
        ok: false,
        error: `spawn_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  ipcMain.handle('pty:attach', (event, sid: string) => {
    const entry = deps.getEntry(sid);
    if (!entry) return null;
    const wc = event.sender;
    entry.attached.set(wc.id, wc);
    // Auto-detach on webContents destruction so we don't accumulate stale
    // refs across renderer reloads / window closes.
    wc.once('destroyed', () => {
      const cur = deps.getEntry(sid);
      if (cur) cur.attached.delete(wc.id);
    });
    return {
      snapshot: entry.serialize.serialize(),
      cols: entry.cols,
      rows: entry.rows,
      pid: entry.pty.pid,
    } satisfies AttachResult;
  });

  ipcMain.handle('pty:detach', (event, sid: string) => {
    const entry = deps.getEntry(sid);
    if (!entry) return;
    entry.attached.delete(event.sender.id);
  });

  ipcMain.handle('pty:input', (_event, sid: string, data: string) => {
    deps.inputPtySession(sid, data);
  });

  ipcMain.handle('pty:resize', (_event, sid: string, cols: number, rows: number) => {
    deps.resizePtySession(sid, cols, rows);
  });

  ipcMain.handle('pty:kill', (_event, sid: string) => deps.killPtySession(sid));

  ipcMain.handle('pty:get', (_event, sid: string) => deps.getPtySession(sid));

  // Claude CLI availability probe. Folded into ptyHost (post-PR-8) from
  // the deleted electron/cliBridge module: ccsm has a single CLI host
  // surface now. Renderer consumes via window.ccsmPty.checkClaudeAvailable.
  // `force: true` bypasses the resolver's success-cache so the user can
  // install claude in another terminal and recover in-place via the
  // ClaudeMissingGuide "Re-check" button without restarting the app.
  ipcMain.handle('pty:checkClaudeAvailable', (_event, opts: unknown) => {
    const force =
      typeof opts === 'object' && opts !== null && (opts as { force?: unknown }).force === true;
    const p = resolveClaude({ force });
    return p ? { available: true as const, path: p } : { available: false as const };
  });
}
