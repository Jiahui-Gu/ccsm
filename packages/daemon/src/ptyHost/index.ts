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
//   - entryFactory.ts   per-session Entry construction + pty/headless wiring
//   - lifecycle.ts      pure spawn/attach/detach/input/resize/kill ops over
//                       a registry Map
//
// This file is the lifecycle-singleton: it owns the one `sessions` Map,
// binds the lifecycle ops to it, and exposes the public API. Wave 0b (#216)
// removed the legacy `ipcRegistrar.ts` + `registerPtyHostIpc` export — the
// daemon takes ownership of the pty IPC surface in Wave 1.

import type { Entry } from './entryFactory.js';
import * as L from './lifecycle.js';

// Re-export the helpers callers historically imported from `ptyHost/index`.
// The unit tests under `__tests__/` import `resolveSpawnCwd` and
// `ensureResumeJsonlAtSpawnCwd` from this module; the notify pipeline
// imports `onPtyData`. Keep that surface stable post-extraction.
export { onPtyData } from './dataFanout.js';
export type { PtyDataListener } from './dataFanout.js';
export {
  ensureResumeJsonlAtSpawnCwd,
  findJsonlForSid,
  resolveJsonlPath,
  toClaudeSid,
} from './jsonlResolver.js';
export type { EnsureResumeJsonlResult } from './jsonlResolver.js';
export { resolveSpawnCwd } from './cwdResolver.js';
export type { PtySessionInfo, AttachResult, BufferSnapshot } from './lifecycle.js';

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

// L4 PR-A (#861) + PR-B (#865): async chunked snapshot of the per-session
// authoritative headless buffer paired with the per-entry chunk seq.
// Returns `{snapshot:'', seq:0}` when the sid isn't registered. Renderer
// uses the seq to dedupe live `pty:data` chunks against the snapshot.
export const getBufferSnapshot = (sid: string): Promise<L.BufferSnapshot> =>
  L.getBufferSnapshot(sessions, sid);

// --- IPC registration --------------------------------------------------------
//
// The legacy `registerPtyHostIpc(ipcMain, getMainWindow)` entrypoint was
// deleted in Wave 0b (#216) along with `ipcRegistrar.ts`. Wave 1 will wire
// pty lifecycle through the daemon's Connect-RPC surface instead of
// Electron's ipcMain.

// --- Test seam ---------------------------------------------------------------

// Used by future ptyHost unit/e2e tests to inspect the running map without
// going through IPC. Production code never reads from this.
export function __getEntryForTest(sid: string): Entry | undefined {
  return sessions.get(sid);
}
