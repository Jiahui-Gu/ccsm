// Main-process pty host.
//
// Replaces the ttyd-in-iframe transport (electron/cliBridge/processManager.ts)
// with an in-process node-pty + @xterm/headless pair per ccsm session. The
// renderer attaches via a `<webview>` (or direct xterm in-process) and consumes
// `pty:data` chunks; on (re)attach it gets a serialized snapshot of the
// headless terminal so reopening a session paints the prior screen
// instantaneously without re-running claude.
//
// Why in-process pty over ttyd:
//   - No second HTTP server / ws hop / Defender firewall prompt.
//   - No respawn-on-ws-disconnect tearing claude down on session switch (the
//     headless mirror keeps the live screen across renderer detaches and
//     replays it on reattach).
//   - Direct write/resize IPC, no ttyd protocol middleman.
//
// JSONL-existence picks --session-id vs --resume on EVERY spawn (mirrors the
// TTYD_WRAPPER_CMD logic in cliBridge/processManager.ts). Wrapper not needed
// because we own the pty lifecycle directly: each `spawnPtySession` call re-
// scans the JSONL roots before invoking pty.spawn.
//
// Module is parallel to electron/cliBridge/* during the transition; both
// surfaces coexist until PR-5 wires this into main.ts and PR-8 deletes
// cliBridge. We re-implement (not import) toClaudeSid + the JSONL probe so
// this module can be deleted/moved independently of cliBridge's removal.
//
// Wire-up happens in PR-5 (main.ts calls registerPtyHostIpc). Preload bridge
// is PR-3. This file ships standalone and only typechecks once PR-1 has added
// the node-pty / @xterm/headless / @xterm/addon-serialize deps.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { BrowserWindow, IpcMain, WebContents } from 'electron';
import * as pty from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { resolveClaude } from './claudeResolver';

// --- Public types ------------------------------------------------------------

export interface PtySessionInfo {
  sid: string;
  pid: number;
  cols: number;
  rows: number;
}

export interface AttachResult {
  snapshot: string;
  cols: number;
  rows: number;
  pid: number;
}

// --- Internal state ----------------------------------------------------------

interface Entry {
  pty: pty.IPty;
  headless: HeadlessTerminal;
  serialize: SerializeAddon;
  // Multiple webContents may attach (e.g. devtools/preview windows); broadcast
  // pty:data to all of them. Keyed by webContents id so detach cleanup is O(1)
  // and we don't pin destroyed senders.
  attached: Map<number, WebContents>;
  cols: number;
  rows: number;
}

const sessions = new Map<string, Entry>();

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const SCROLLBACK = 5000;

// --- Helpers -----------------------------------------------------------------

// Project an arbitrary ccsm sid onto a deterministic UUID v4 string so claude
// (which requires a valid UUID for --session-id / --resume) accepts it.
// Re-implemented here rather than imported from cliBridge so this module is
// self-contained for the cliBridge removal in PR-8.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toClaudeSid(ccsmSessionId: string): string {
  if (UUID_V4_RE.test(ccsmSessionId)) return ccsmSessionId.toLowerCase();
  const hex = createHash('sha256').update(ccsmSessionId).digest('hex');
  const yNibble = (parseInt(hex[16], 16) & 0x3) | 0x8;
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${yNibble.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

// Scan both possible JSONL roots (CLAUDE_CONFIG_DIR override + USERPROFILE
// default) for `<sid>.jsonl` with non-zero size. Mirrors the .cmd wrapper in
// cliBridge/processManager.ts, just expressed in Node. Non-zero size guards
// against the empty-file race where claude has created but not yet written
// the transcript.
function jsonlExistsForSid(sid: string): boolean {
  const filename = `${sid}.jsonl`;
  const roots: string[] = [];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) roots.push(pathJoin(cfg, 'projects'));
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) roots.push(pathJoin(home, '.claude', 'projects'));

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const candidate = pathJoin(root, name, filename);
      try {
        const st = statSync(candidate);
        if (st.isFile() && st.size > 0) return true;
      } catch {
        /* not present in this project dir */
      }
    }
  }
  return false;
}

function makeEntry(
  sid: string,
  cwd: string,
  claudePath: string,
  cols: number,
  rows: number,
): Entry {
  const claudeSid = toClaudeSid(sid);
  const flag = jsonlExistsForSid(claudeSid) ? '--resume' : '--session-id';
  const args = [flag, claudeSid];

  const p = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd && cwd.length > 0 ? cwd : process.cwd(),
    env: process.env as { [key: string]: string },
  });

  const headless = new HeadlessTerminal({
    cols,
    rows,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
  });
  const serialize = new SerializeAddon();
  headless.loadAddon(serialize);

  const entry: Entry = {
    pty: p,
    headless,
    serialize,
    attached: new Map(),
    cols,
    rows,
  };

  p.onData((chunk) => {
    headless.write(chunk);
    for (const wc of entry.attached.values()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send('pty:data', { sid, chunk });
        } catch {
          /* renderer gone — best effort */
        }
      }
    }
  });

  p.onExit(({ exitCode, signal }) => {
    // Broadcast exit to anyone still listening, then drop the entry. Using
    // `sessionId` in the payload (not just `sid`) matches the renderer-side
    // ttyd-exit shape so the existing exit handler can be reused.
    for (const wc of entry.attached.values()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send('pty:exit', {
            sessionId: sid,
            code: exitCode ?? null,
            signal: signal ?? null,
          });
        } catch {
          /* renderer gone */
        }
      }
    }
    try {
      headless.dispose();
    } catch {
      /* already disposed */
    }
    sessions.delete(sid);
  });

  return entry;
}

// --- Public API --------------------------------------------------------------

export function spawnPtySession(
  sid: string,
  cwd: string,
  claudePath: string,
  opts?: { cols?: number; rows?: number },
): PtySessionInfo {
  const existing = sessions.get(sid);
  if (existing) {
    return {
      sid,
      pid: existing.pty.pid,
      cols: existing.cols,
      rows: existing.rows,
    };
  }
  const cols = opts?.cols ?? DEFAULT_COLS;
  const rows = opts?.rows ?? DEFAULT_ROWS;
  const entry = makeEntry(sid, cwd, claudePath, cols, rows);
  sessions.set(sid, entry);
  return { sid, pid: entry.pty.pid, cols, rows };
}

export function listPtySessions(): PtySessionInfo[] {
  return Array.from(sessions.entries()).map(([sid, e]) => ({
    sid,
    pid: e.pty.pid,
    cols: e.cols,
    rows: e.rows,
  }));
}

export function attachPtySession(sid: string): AttachResult | null {
  const entry = sessions.get(sid);
  if (!entry) return null;
  // Caller registers their webContents via the IPC handler (see
  // registerPtyHostIpc) — the bare API only returns the snapshot. Renderer
  // tests can use this without an IPC round-trip.
  return {
    snapshot: entry.serialize.serialize(),
    cols: entry.cols,
    rows: entry.rows,
    pid: entry.pty.pid,
  };
}

export function detachPtySession(sid: string): void {
  // No-op at the API level — IPC handler clears the per-webContents
  // registration. Kept on the surface so the preload bridge has a symmetric
  // attach/detach pair.
  void sid;
}

export function inputPtySession(sid: string, data: string): void {
  const entry = sessions.get(sid);
  if (!entry) return;
  try {
    entry.pty.write(data);
  } catch {
    /* pty already exited — exit handler will clean up */
  }
}

export function resizePtySession(sid: string, cols: number, rows: number): void {
  const entry = sessions.get(sid);
  if (!entry) return;
  if (cols < 2 || rows < 2) return;
  try {
    entry.pty.resize(cols, rows);
    entry.headless.resize(cols, rows);
    entry.cols = cols;
    entry.rows = rows;
  } catch (e) {
    console.warn(
      `[ptyHost] resize ${sid} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function killPtySession(sid: string): boolean {
  const entry = sessions.get(sid);
  if (!entry) return false;
  try {
    entry.pty.kill();
  } catch {
    /* already dead */
  }
  // headless dispose + map delete happen in the onExit handler so we don't
  // double-clean. Belt-and-braces drop here in case onExit doesn't fire (rare:
  // the binding has fired reliably on Windows conpty in spike testing).
  return true;
}

export function getPtySession(sid: string): PtySessionInfo | null {
  const entry = sessions.get(sid);
  if (!entry) return null;
  return { sid, pid: entry.pty.pid, cols: entry.cols, rows: entry.rows };
}

// Kill every running pty. Call from app `before-quit` so renderer-side
// claude processes don't leak past Electron exit.
export function killAllPtySessions(): void {
  for (const sid of [...sessions.keys()]) {
    killPtySession(sid);
  }
}

// --- IPC registration --------------------------------------------------------

// Register all `pty:*` IPC handlers. `getMainWindow` is reserved for future
// broadcast paths that don't have a per-webContents sender (currently every
// emit targets the attached webContents directly, but PR-5 may need to
// fall back to the main window for unsolicited events).
export function registerPtyHostIpc(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
): void {
  void getMainWindow;

  ipcMain.handle('pty:list', () => listPtySessions());

  ipcMain.handle('pty:spawn', (_event, sid: string, cwd: string) => {
    const claudePath = resolveClaude();
    if (!claudePath) {
      return { ok: false, error: 'claude_not_found' };
    }
    try {
      const info = spawnPtySession(sid, cwd, claudePath);
      return { ok: true, ...info };
    } catch (err) {
      return {
        ok: false,
        error: `spawn_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  ipcMain.handle('pty:attach', (event, sid: string) => {
    const entry = sessions.get(sid);
    if (!entry) return null;
    const wc = event.sender;
    entry.attached.set(wc.id, wc);
    // Auto-detach on webContents destruction so we don't accumulate stale
    // refs across renderer reloads / window closes.
    wc.once('destroyed', () => {
      const cur = sessions.get(sid);
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
    const entry = sessions.get(sid);
    if (!entry) return;
    entry.attached.delete(event.sender.id);
  });

  ipcMain.handle('pty:input', (_event, sid: string, data: string) => {
    inputPtySession(sid, data);
  });

  ipcMain.handle('pty:resize', (_event, sid: string, cols: number, rows: number) => {
    resizePtySession(sid, cols, rows);
  });

  ipcMain.handle('pty:kill', (_event, sid: string) => killPtySession(sid));

  ipcMain.handle('pty:get', (_event, sid: string) => getPtySession(sid));

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

// --- Test seam ---------------------------------------------------------------

// Used by future ptyHost unit/e2e tests to inspect the running map without
// going through IPC. Production code never reads from this.
export function __getEntryForTest(sid: string): Entry | undefined {
  return sessions.get(sid);
}
