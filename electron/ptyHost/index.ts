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
// SRP layout (Task #729 Phase A): this file owns the per-session lifecycle
// (Entry creation + spawn / attach / detach / kill). Helpers split into:
//   - jsonlResolver.ts  pure deciders for the CLI's transcript paths
//   - cwdResolver.ts    pure decider for the spawn cwd fallback
//   - processKiller.ts  single sink (taskkill / kill -SIGTERM/SIGKILL)
//   - dataFanout.ts     module-level pty:data subscriber registry
//   - ipcRegistrar.ts   the eight `pty:*` IPC handlers + watcher bridge

import type { BrowserWindow, IpcMain, WebContents } from 'electron';
import * as pty from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { sessionWatcher } from '../sessionWatcher';
import {
  ensureResumeJsonlAtSpawnCwd,
  findJsonlForSid,
  resolveJsonlPath,
  toClaudeSid,
} from './jsonlResolver';
import { resolveSpawnCwd } from './cwdResolver';
import { killProcessSubtree } from './processKiller';
import { emitPtyData } from './dataFanout';
import { registerPtyIpc } from './ipcRegistrar';

// Re-export the helpers callers historically imported from `ptyHost/index`.
// The unit tests under `__tests__/` import `resolveSpawnCwd` and
// `ensureResumeJsonlAtSpawnCwd` from this module; the notify pipeline
// imports `onPtyData`. Keep that surface stable post-extraction.
export { onPtyData } from './dataFanout';
export type { PtyDataListener } from './dataFanout';
export {
  ensureResumeJsonlAtSpawnCwd,
  findJsonlForSid,
  resolveJsonlPath,
  toClaudeSid,
} from './jsonlResolver';
export type { EnsureResumeJsonlResult } from './jsonlResolver';
export { resolveSpawnCwd } from './cwdResolver';

// --- Public types ------------------------------------------------------------

export interface PtySessionInfo {
  sid: string;
  pid: number;
  cols: number;
  rows: number;
  /** Working directory the PTY was actually spawned with (post-`resolveSpawnCwd`
   *  fallback). Diverges from the renderer's `session.cwd` ONLY when the
   *  requested cwd was missing/unreadable, in which case `resolveSpawnCwd`
   *  falls back to homedir. Surfaced so e2e probes can verify that picked
   *  cwds reach the real PTY (#628). */
  cwd: string;
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
  /** Resolved spawn cwd (after `resolveSpawnCwd` fallback). Captured here
   *  so `listPtySessions` / `getPtySession` can return it without re-deriving. */
  cwd: string;
}

const sessions = new Map<string, Entry>();

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const SCROLLBACK = 5000;

// --- Entry construction ------------------------------------------------------

function makeEntry(
  sid: string,
  cwd: string,
  claudePath: string,
  cols: number,
  rows: number,
  onCwdRedirect?: (newCwd: string) => void,
): Entry {
  const claudeSid = toClaudeSid(sid);
  const sourceJsonl = findJsonlForSid(claudeSid);
  const flag = sourceJsonl ? '--resume' : '--session-id';
  const args = [flag, claudeSid];

  const spawnCwd = resolveSpawnCwd(cwd);

  // See `ensureResumeJsonlAtSpawnCwd` for the bug context (#603) — copies
  // the import-source JSONL into the spawn cwd's projectDir so
  // `claude --resume <sid>` can find it. No-op when source already lives
  // under the right projectKey (the common case for sessions originally
  // run from a still-existing cwd).
  //
  // When a copy actually happens, the live JSONL the CLI now appends to
  // lives under `projectKey(spawnCwd)`, NOT under `projectKey(session.cwd)`.
  // The renderer's sessionTitles bridge passes `session.cwd` to the SDK
  // (`renameSession` / `getSessionInfo` / `listForProject`), so without a
  // redirect the bridge would keep reading/writing the now-frozen SOURCE
  // file (#603 reviewer Layer-1 finding). Notify the caller so it can
  // patch `session.cwd` to `spawnCwd` in the renderer store.
  if (sourceJsonl) {
    const result = ensureResumeJsonlAtSpawnCwd(claudeSid, spawnCwd, sourceJsonl);
    if (result.copied && onCwdRedirect) {
      try {
        onCwdRedirect(spawnCwd);
      } catch (err) {
        console.warn(
          `[ptyHost] cwd-redirect notify for ${sid} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const p = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spawnCwd,
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
    cwd: spawnCwd,
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
    // Fan out to module-level data listeners (notify pipeline OSC sniffer
    // is the only production consumer today). Listeners are best-effort —
    // throws don't propagate back to ptyHost so a misbehaving sink can't
    // wedge the PTY.
    emitPtyData(sid, chunk);
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
    // Stop the JSONL tail-watcher so we don't keep an fs.watch handle
    // pinned for a dead session.
    try { sessionWatcher.stopWatching(sid); } catch { /* never throws */ }
  });

  // Start a JSONL tail-watcher for this session. The watcher emits
  // 'state-changed' on the singleton in electron/sessionWatcher; main.ts
  // bridges those events to the renderer (`session:state` IPC channel).
  try {
    const jsonlPath = resolveJsonlPath(claudeSid, spawnCwd);
    if (jsonlPath) sessionWatcher.startWatching(sid, jsonlPath, spawnCwd);
  } catch {
    /* watcher start is best-effort; PTY still owns its lifecycle */
  }

  return entry;
}

// --- Public API --------------------------------------------------------------

export function spawnPtySession(
  sid: string,
  cwd: string,
  claudePath: string,
  opts?: { cols?: number; rows?: number; onCwdRedirect?: (newCwd: string) => void },
): PtySessionInfo {
  const existing = sessions.get(sid);
  if (existing) {
    return {
      sid,
      pid: existing.pty.pid,
      cols: existing.cols,
      rows: existing.rows,
      cwd: existing.cwd,
    };
  }
  const cols = opts?.cols ?? DEFAULT_COLS;
  const rows = opts?.rows ?? DEFAULT_ROWS;
  const entry = makeEntry(sid, cwd, claudePath, cols, rows, opts?.onCwdRedirect);
  sessions.set(sid, entry);
  return { sid, pid: entry.pty.pid, cols, rows, cwd: entry.cwd };
}

export function listPtySessions(): PtySessionInfo[] {
  return Array.from(sessions.entries()).map(([sid, e]) => ({
    sid,
    pid: e.pty.pid,
    cols: e.cols,
    rows: e.rows,
    cwd: e.cwd,
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
  // Capture pid BEFORE pty.kill() — the binding may zero it after kill.
  const pid = entry.pty.pid;
  try {
    entry.pty.kill();
  } catch {
    /* already dead */
  }
  // ConPTY's kill only terminates the cmd.exe / OpenConsole wrapper; on Windows
  // the claude.exe child (and its grandchildren) survive as orphans. On
  // mac/linux the pgid may also have stragglers. Walk the tree via a
  // platform-native call to guarantee a clean shutdown.
  killProcessSubtree(pid);
  // Belt-and-braces: also stop the watcher synchronously here so a
  // pty.kill that races with onExit can't leak the fs.watch handle.
  // sessionWatcher.stopWatching is idempotent.
  try { sessionWatcher.stopWatching(sid); } catch { /* never throws */ }
  return true;
}

export function getPtySession(sid: string): PtySessionInfo | null {
  const entry = sessions.get(sid);
  if (!entry) return null;
  return { sid, pid: entry.pty.pid, cols: entry.cols, rows: entry.rows, cwd: entry.cwd };
}

// Kill every running pty. Call from app `before-quit` so renderer-side
// claude processes don't leak past Electron exit.
export function killAllPtySessions(): void {
  for (const sid of [...sessions.keys()]) {
    killPtySession(sid);
  }
}

// --- IPC registration --------------------------------------------------------

// Register all `pty:*` IPC handlers. Thin wrapper around `registerPtyIpc`
// in ipcRegistrar.ts that wires the registrar's deps to this module's
// lifecycle functions. Kept on this surface so main.ts wires up via a
// single call (`registerPtyHostIpc(ipcMain, getMainWindow)`) — moving it
// would touch main.ts which is out of scope for Task #729 Phase A.
export function registerPtyHostIpc(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
): void {
  registerPtyIpc(ipcMain, {
    getMainWindow,
    getEntry: (sid) => sessions.get(sid),
    listPtySessions,
    spawnPtySession,
    inputPtySession,
    resizePtySession,
    killPtySession,
    getPtySession,
  });
}

// --- Test seam ---------------------------------------------------------------

// Used by future ptyHost unit/e2e tests to inspect the running map without
// going through IPC. Production code never reads from this.
export function __getEntryForTest(sid: string): Entry | undefined {
  return sessions.get(sid);
}
