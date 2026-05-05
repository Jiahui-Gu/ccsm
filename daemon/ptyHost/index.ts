// Main-process pty host — daemon edition (W2-B / Task #581).
//
// Originally lived under `electron/ptyHost/`; W2-B moved the whole subtree
// into `daemon/ptyHost/` so the long-lived process that actually owns the
// node-pty handles is the daemon, not Electron's main process. The renderer
// no longer talks to ptyHost via Electron IPC; it goes through the
// `daemon/api/pty.ts` HTTP + SSE surface (`/api/pty/*` and
// `/api/events/pty?sid=...`).
//
// What `electron/ptyHost/index.ts` used to expose has been split:
//   * the lifecycle singleton (sessions Map, public spawn/attach/...) lives
//     here unchanged, just minus the `registerPtyHostIpc` glue;
//   * the IPC registrar (`ipcRegistrar.ts`) is gone — `daemon/api/pty.ts`
//     replaces it with HTTP route handlers + an SSE multiplexer.
//
// Dependency notes:
//   * `entryFactory.ts` / `lifecycle.ts` still need `electron/sessionWatcher`
//     for JSONL tail watching (state/title fan-out). Until W2-C moves the
//     watcher into daemon/, the import path crosses the daemon ↔ electron
//     tree boundary (`'../sessionWatcher'`). The daemon
//     tsconfig has been widened to include the watcher subtree to keep the
//     graph compilable.
//
// Replaces the ttyd-in-iframe transport (electron/cliBridge/processManager.ts)
// with an in-process node-pty + @xterm/headless pair per ccsm session. The
// renderer attaches via SSE and consumes `pty:data` chunks; on (re)attach it
// gets a serialized snapshot of the headless terminal so reopening a session
// paints the prior screen instantaneously without re-running claude.
//
// JSONL-existence picks --session-id vs --resume on EVERY spawn (mirrors the
// TTYD_WRAPPER_CMD logic in cliBridge/processManager.ts). Wrapper not needed
// because we own the pty lifecycle directly: each `spawnPtySession` call re-
// scans the JSONL roots before invoking pty.spawn.

import type { Entry, PtyAttachedSubscriber } from './entryFactory';
import * as L from './lifecycle';

// Re-export the helpers callers historically imported from `ptyHost/index`.
// The unit tests under `__tests__/` import `resolveSpawnCwd` and
// `ensureResumeJsonlAtSpawnCwd` from this module; the notify pipeline
// imports `onPtyData`. Keep that surface stable post-extraction.
export { onPtyData, onPtyChunk, onPtyExit } from './dataFanout';
export type { PtyDataListener, PtyChunkListener, PtyExitListener } from './dataFanout';
export {
  ensureResumeJsonlAtSpawnCwd,
  findJsonlForSid,
  resolveJsonlPath,
  toClaudeSid,
} from './jsonlResolver';
export type { EnsureResumeJsonlResult } from './jsonlResolver';
export { resolveSpawnCwd } from './cwdResolver';
export type { PtySessionInfo, AttachResult, BufferSnapshot } from './lifecycle';
export type { PtyAttachedSubscriber } from './entryFactory';

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

// --- Subscriber registration (used by daemon/api/pty.ts SSE multiplexer) ----

/** Register a subscriber that will receive `pty:data` and `pty:exit` events
 *  pushed via `Entry.attached`. Returns false when the sid is unknown (caller
 *  should treat as a 404 / `pty:exit` already fired). The HTTP layer keeps a
 *  reference to `subscriber` and is responsible for un-registering on client
 *  disconnect. */
export function registerSubscriber(sid: string, subscriber: PtyAttachedSubscriber): boolean {
  const entry = sessions.get(sid);
  if (!entry) return false;
  entry.attached.set(subscriber.id, subscriber);
  return true;
}

export function unregisterSubscriber(sid: string, subscriberId: string): void {
  const entry = sessions.get(sid);
  if (!entry) return;
  entry.attached.delete(subscriberId);
}

// --- Test seam ---------------------------------------------------------------

// Used by future ptyHost unit/e2e tests to inspect the running map without
// going through the HTTP layer. Production code never reads from this.
export function __getEntryForTest(sid: string): Entry | undefined {
  return sessions.get(sid);
}
