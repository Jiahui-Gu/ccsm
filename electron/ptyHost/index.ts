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
// SRP layout (Task #729 Phase A + Task #738 Phase B):
//   - jsonlResolver.ts  pure deciders for the CLI's transcript paths
//   - cwdResolver.ts    pure decider for the spawn cwd fallback
//   - processKiller.ts  single sink (taskkill / kill -SIGTERM/SIGKILL)
//   - dataFanout.ts     module-level pty:data subscriber registry
//   - ipcRegistrar.ts   the eight `pty:*` IPC handlers + watcher bridge
//   - entryFactory.ts   per-session Entry construction + pty/headless wiring
//   - lifecycle.ts      pure spawn/attach/detach/input/resize/kill ops over
//                       a registry Map
//
// This file is the lifecycle-singleton: it owns the one `sessions` Map,
// binds the lifecycle ops to it, exposes the public API, and wires IPC.

import type { BrowserWindow, IpcMain } from 'electron';
import type { Entry } from './entryFactory';
import * as L from './lifecycle';
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
export type { PtySessionInfo, AttachResult } from './lifecycle';

// --- Singleton registry ------------------------------------------------------

const sessions = new Map<string, Entry>();

// --- Public API (lifecycle ops bound to the singleton) -----------------------

export function spawnPtySession(
  sid: string,
  cwd: string,
  claudePath: string,
  opts?: { cols?: number; rows?: number; onCwdRedirect?: (newCwd: string) => void },
): L.PtySessionInfo {
  return L.spawn(sessions, sid, cwd, claudePath, opts);
}

export const listPtySessions = (): L.PtySessionInfo[] => L.list(sessions);

export const attachPtySession = (sid: string): L.AttachResult | null =>
  L.attach(sessions, sid);

export const detachPtySession = (sid: string): void => L.detach(sessions, sid);

export const inputPtySession = (sid: string, data: string): void =>
  L.input(sessions, sid, data);

export const resizePtySession = (sid: string, cols: number, rows: number): void =>
  L.resize(sessions, sid, cols, rows);

export const killPtySession = (sid: string): boolean => L.kill(sessions, sid);

export const getPtySession = (sid: string): L.PtySessionInfo | null =>
  L.get(sessions, sid);

export const killAllPtySessions = (): void => L.killAll(sessions);

// --- IPC registration --------------------------------------------------------

// Register all `pty:*` IPC handlers. Thin wrapper around `registerPtyIpc`
// in ipcRegistrar.ts that wires the registrar's deps to this module's
// lifecycle functions. Kept on this surface so main.ts wires up via a
// single call (`registerPtyHostIpc(ipcMain, getMainWindow)`).
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
