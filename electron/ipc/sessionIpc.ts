// Session-scoped IPC handlers. Extracted from electron/main.ts (Task #742
// Phase B).
//
// Two clusters:
//   1. sessionTitles bridge — thin wrappers around the SDK's getSessionInfo
//      / renameSession / listSessions, with per-sid serialization, 2s TTL
//      cache, error normalization, and the pending-rename queue all living
//      in `electron/sessionTitles`. This module only forwards.
//   2. Renderer→main session signals — `session:setActive`, `session:setName`,
//      `notify:userInput`. These mutate cross-module state owned by main.ts
//      (active-sid mirror, names map, notify pipeline reference, badge
//      controller). All state mutations happen via the deps bag so the
//      module remains free of a back-import to main.ts.
//
// Why DI for the signals: the notify pipeline is constructed lazily inside
// app.whenReady() (after the IPC handlers are registered) and the
// active-sid mirror is shared across multiple producers (focus changes,
// notify pipeline ctx, badge controller). Passing setters/getters keeps
// main.ts as the single owner of the live values.

import type { IpcMain } from 'electron';
import {
  getSessionTitle,
  renameSessionTitle,
  listProjectSummaries,
  enqueuePendingRename,
  flushPendingRename,
} from '../sessionTitles';
import { fromMainFrame } from '../security/ipcGuards';

export interface SessionIpcDeps {
  ipcMain: IpcMain;
  /** Persist the renderer's current activeId so the notify bridge can
   *  suppress toasts for the session the user is already looking at without
   *  a synchronous round-trip to read renderer state. Pass `null` to clear. */
  setActiveSid: (sid: string | null) => void;
  /** Side-effect callback fired after activeSid changes. Used by main.ts to
   *  push the new activeSid into the badge controller and the notify
   *  pipeline (both of which are owned by main.ts). */
  onActiveSidChanged: (sid: string | null) => void;
  /** Set/clear the user-visible name for a sid so notify toasts can label
   *  with the rename / SDK auto-summary instead of the bare UUID. */
  setSessionName: (sid: string, name: string | null) => void;
  /** Forward to the notify pipeline's "user touched this session" signal.
   *  Decoupled from setActiveSid because tray-click activate-on-toast
   *  shouldn't reset Rule 1's user-input clock (#715). */
  markUserInput: (sid: string) => void;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
  const {
    ipcMain,
    setActiveSid,
    onActiveSidChanged,
    setSessionName,
    markUserInput,
  } = deps;

  // ─────────────────────── sessionTitles bridge ──────────────────────────
  ipcMain.handle('sessionTitles:get', (_e, sid: string, dir?: string) =>
    getSessionTitle(sid, dir),
  );
  ipcMain.handle(
    'sessionTitles:rename',
    (_e, sid: string, title: string, dir?: string) =>
      renameSessionTitle(sid, title, dir),
  );
  ipcMain.handle('sessionTitles:listForProject', (_e, projectKey: string) =>
    listProjectSummaries(projectKey),
  );
  // Pending-rename queue. Renderer enqueues when SDK reports `no_jsonl`
  // (rename happened before the first message flushed the JSONL file). The
  // sessionWatcher (PR3) is the only production caller of `flushPending` —
  // it fires when the watcher first sees the JSONL appear.
  ipcMain.handle(
    'sessionTitles:enqueuePending',
    (_e, sid: string, title: string, dir?: string) => {
      enqueuePendingRename(sid, title, dir);
    },
  );
  ipcMain.handle('sessionTitles:flushPending', (_e, sid: string) =>
    flushPendingRename(sid),
  );

  // ─────────────────────── renderer→main signals ─────────────────────────
  // Renderer mirrors its active session id here so the notify bridge can
  // suppress toasts for the session the user is currently viewing. Plain
  // `ipcMain.on` (no reply); the renderer fires this on every selectSession.
  ipcMain.on('session:setActive', (e, sid: unknown) => {
    if (!fromMainFrame(e)) return;
    const next =
      typeof sid === 'string' && sid.length > 0 ? sid : null;
    setActiveSid(next);
    // Notify pipeline + badge controller fan-out lives in main.ts; we just
    // signal the change. Do NOT count a sidebar switch as user input:
    // clicking a session in the sidebar is a navigation gesture, not
    // user-typed input, and feeding it into Rule 1 would mute legitimate
    // idle/waiting toasts for 60s every time the user merely opens the
    // session (#715). Real user input flows via `notify:userInput` below.
    onActiveSidChanged(next);
  });

  // Explicit "user touched this session" IPC — fired by the renderer on
  // new-session create / import / resume, in addition to the implicit
  // setActive trigger above. Decouples Rule 1's intent (the user just
  // initiated this session) from the active-sid bookkeeping (which can
  // happen for non-user-driven reasons, e.g. activate-on-toast-click).
  ipcMain.on('notify:userInput', (e, sid: unknown) => {
    if (!fromMainFrame(e)) return;
    if (typeof sid !== 'string' || sid.length === 0) return;
    markUserInput(sid);
  });

  // Renderer pushes the user-visible name for a sid so notify toasts can
  // show "my-feature-branch" instead of the UUID. Empty/missing name clears
  // the entry (renderer signals "no longer have a name"). Same security
  // posture as session:setActive — main-frame only.
  ipcMain.on('session:setName', (e, payload: unknown) => {
    if (!fromMainFrame(e)) return;
    if (!payload || typeof payload !== 'object') return;
    const { sid, name } = payload as { sid?: unknown; name?: unknown };
    if (typeof sid !== 'string' || sid.length === 0) return;
    setSessionName(
      sid,
      typeof name === 'string' && name.length > 0 ? name : null,
    );
  });
}
