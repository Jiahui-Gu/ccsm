// Registers the eight `pty:*` IPC handlers + the sessionWatcher → renderer
// state/title bridge.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A) so the
// lifecycle layer (entry creation / spawn / attach / kill) is no longer
// tangled with the IPC surface. The registrar owns no state of its own
// beyond the one-shot `stateBridgeInstalled` guard.

import fs from 'node:fs';
import path from 'node:path';
import { app, clipboard, type BrowserWindow, type IpcMain } from 'electron';
import { resolveClaude } from './claudeResolver';
import { sessionWatcher } from '../sessionWatcher';
import type { AttachResult, BufferSnapshot, PtySessionInfo } from './lifecycle';
import { PTY_CHANNELS, SESSION_CHANNELS } from '../shared/ipcChannels';

/**
 * Task #42 — clipboard image auto-save. Filename format:
 * `YYYYMMDD-HHMMSS[-NNN].png`. Local time (matches the user's Finder /
 * Explorer column when they go looking for the file). The `-NNN` suffix
 * is appended on same-second collisions; we cap retries at 999 so a
 * runaway loop can't pin the main thread.
 */
function formatClipboardImageTimestamp(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Resolve a non-colliding filename inside `dir` for the given timestamp
 * base. Uses sync existsSync because the loop must be atomic w.r.t. the
 * subsequent write — interleaving another async tick here would race
 * two paste-image calls landing the same second.
 */
function resolveClipboardImagePath(dir: string, base: string): string {
  let file = path.join(dir, `${base}.png`);
  for (let n = 1; n < 1000 && fs.existsSync(file); n++) {
    file = path.join(dir, `${base}-${String(n).padStart(3, '0')}.png`);
  }
  return file;
}

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
    opts?: {
      cols?: number;
      rows?: number;
      onCwdRedirect?: (newCwd: string) => void;
      forkSourceSid?: string;
    },
  ) => PtySessionInfo;
  inputPtySession: (sid: string, data: string) => void;
  resizePtySession: (sid: string, cols: number, rows: number) => void;
  killPtySession: (sid: string) => Promise<boolean>;
  getPtySession: (sid: string) => PtySessionInfo | null;
  /** L4 PR-B (#865): async chunked snapshot + capture seq. Routed through
   *  the deps surface (rather than direct module import) so the registrar
   *  stays decoupled from the lifecycle singleton — same pattern as the
   *  other lifecycle ops above. */
  getBufferSnapshot: (sid: string) => Promise<BufferSnapshot>;
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
        wc.send(SESSION_CHANNELS.state, evt);
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
        wc.send(SESSION_CHANNELS.title, evt);
      } catch {
        /* renderer gone */
      }
    });
    stateBridgeInstalled = true;
  }

  ipcMain.handle(PTY_CHANNELS.list, () => deps.listPtySessions());

  ipcMain.handle(PTY_CHANNELS.spawn, async (_event, sid: string, cwd: string, forkSourceSid?: string) => {
    const claudePath = await resolveClaude();
    if (!claudePath) {
      return { ok: false, error: 'claude_not_found' };
    }
    // Defense-in-depth: only accept a string (and in the same shape as `sid`
    // — `toClaudeSid` will throw on anything that doesn't pass `VALID_SID_RE`,
    // so a malformed value here surfaces as `spawn_failed:` rather than
    // landing as raw argv text). Anything else (number, object, array,
    // undefined → rest-arg behavior) is dropped to undefined.
    const fork = typeof forkSourceSid === 'string' && forkSourceSid.length > 0
      ? forkSourceSid
      : undefined;
    // L4 PR-F (#867): the renderer no longer forwards initial cols/rows.
    // The PTY launches at the lifecycle defaults (DEFAULT_COLS/ROWS) and
    // the renderer's post-attach `pty:resize` (with snapshot replay,
    // PR-D #866) reflows both the PTY and the headless source-of-truth
    // buffer to the real viewport, then repaints the visible xterm from
    // the reflowed snapshot. This makes the spawn-time #852 hack
    // (renderer measures viewport via FitAddon, forwards to spawn,
    // main floor+clamps to >=2 and threads through spawnPtySession)
    // redundant; it has been removed.
    try {
      const info = deps.spawnPtySession(sid, cwd, claudePath, {
        forkSourceSid: fork,
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
            wc.send(SESSION_CHANNELS.cwdRedirected, { sid, newCwd });
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

  ipcMain.handle(PTY_CHANNELS.attach, (event, sid: string) => {
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
      cols: entry.cols,
      rows: entry.rows,
      pid: entry.pty.pid,
    } satisfies AttachResult;
  });

  ipcMain.handle(PTY_CHANNELS.detach, (event, sid: string) => {
    const entry = deps.getEntry(sid);
    if (!entry) return;
    entry.attached.delete(event.sender.id);
  });

  ipcMain.handle(PTY_CHANNELS.input, (_event, sid: string, data: string) => {
    // Defense-in-depth: TypeScript signature is advisory across the IPC
    // boundary — a compromised renderer (or a buggy preload bridge) can
    // hand us anything. node-pty's `write` truncates non-strings silently
    // or throws inside the addon, neither of which we want.
    if (typeof data !== 'string') return;
    deps.inputPtySession(sid, data);
  });

  ipcMain.handle(PTY_CHANNELS.resize, (_event, sid: string, cols: number, rows: number) => {
    // Dimension policy (floor/ceiling/NaN) lives in `lifecycle.resize` via
    // `normalizeResizeDims` — the single convergence point both transports
    // funnel through. Forward raw so desktop and remote get identical
    // handling; the lifecycle validator is the only path to node-pty.
    deps.resizePtySession(sid, cols, rows);
  });

  // Race fix (#1277 review): killPtySession returns a Promise that resolves
  // only after pty.onExit fires (entry removed from sessions Map) or
  // KILL_EXIT_TIMEOUT_MS elapses. ipcMain.handle awaits the return so the
  // renderer's `await ccsmPty.kill(sid)` does NOT resolve until the entry
  // is gone — a subsequent `pty:attach` is then guaranteed to see null and
  // walk the spawn-on-null fallback rather than registering as a viewer of
  // a dying pty.
  ipcMain.handle(PTY_CHANNELS.kill, async (_event, sid: string) => deps.killPtySession(sid));

  ipcMain.handle(PTY_CHANNELS.get, (_event, sid: string) => deps.getPtySession(sid));

  // L4 PR-B (#865) — visible xterm attach replay channel. Returns the
  // serialized headless buffer plus the captured chunk seq so the
  // renderer can drop live `pty:data` chunks already baked into the
  // snapshot. Async so a multi-MB serialize doesn't block the main
  // thread — `lifecycle.getBufferSnapshot` chunks the join.
  ipcMain.handle(PTY_CHANNELS.getBufferSnapshot, (_event, sid: string) =>
    deps.getBufferSnapshot(sid),
  );

  // Claude CLI availability probe. Folded into ptyHost (post-PR-8) from
  // the deleted electron/cliBridge module: ccsm has a single CLI host
  // surface now. Renderer consumes via window.ccsmPty.checkClaudeAvailable.
  // `force: true` bypasses the resolver's success-cache so the user can
  // install claude in another terminal and recover in-place via the
  // ClaudeMissingGuide "Re-check" button without restarting the app.
  ipcMain.handle(PTY_CHANNELS.checkClaudeAvailable, async (_event, opts: unknown) => {
    const force =
      typeof opts === 'object' && opts !== null && (opts as { force?: unknown }).force === true;
    const p = await resolveClaude({ force });
    return p ? { available: true as const, path: p } : { available: false as const };
  });

  // Task #42 — when the renderer detects a paste intent and the clipboard
  // holds an image (e.g. user took a screenshot, dragged a PNG into the
  // clipboard, or copied from a browser), drop it to disk under
  // `<userData>/clipboard-images/` and return the absolute path so the
  // renderer can inject the path into the active PTY. Claude reads files
  // by path, so this is the canonical way to feed it a screenshot.
  //
  // Returns null when there is no image on the clipboard — renderer falls
  // back to its normal text-paste path. We do NOT inspect text here, even
  // when text is also present, because Windows readText() is unreliable
  // when the clipboard holds an image (readImage().isEmpty() IS reliable).
  // The renderer holds the text fallback synchronously before invoking us.
  ipcMain.handle(PTY_CHANNELS.saveClipboardImage, async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const buf = img.toPNG();
    if (buf.length === 0) return null;
    const dir = path.join(app.getPath('userData'), 'clipboard-images');
    await fs.promises.mkdir(dir, { recursive: true });
    const base = formatClipboardImageTimestamp(new Date());
    const file = resolveClipboardImagePath(dir, base);
    await fs.promises.writeFile(file, buf);
    return file;
  });
}
