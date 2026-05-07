// Zustand store for the multi-session frontend.
//
// HISTORY:
//   - T9 (#656): introduced the multi-session table + activeSid + a single
//     `status` slot for the active ws.
//   - T10 (#662): added a per-session status map (`sessionStatuses`) so each
//     row's connection state can be surfaced independently. Per-session
//     scrollback + ws lifecycle live in `session-runtime.ts` (off-store, by
//     design — see that module for the rationale).
//
// SCOPE — what the store owns:
//   - Flat list of `SessionInfo` (sid + createdAt + alive flag).
//   - `activeSid` pointer for which row the MainPane renders.
//   - `sessionStatuses` map: per-sid WsStatus (the runtime publishes here
//     after every status transition; UI components subscribe through the
//     usual zustand hook).
//   - Legacy `status` field reflects the active sid's status, for backward
//     compatibility with components that haven't migrated to the per-sid
//     map yet (Sidebar today).
//
// EXPLICITLY OUT OF SCOPE:
//   - Real groups (rename/move/multi-group) — DESIGN.md §7 reserves this for
//     post-MVP; the sidebar renders a fixed "default" group only.
//   - Persistence (sessionStorage / localStorage of the session list).
//   - Scrollback / ws / reconnect — owned by session-runtime.ts.

import type { SessionInfo } from '@ccsm/shared';
import { create } from 'zustand';
import type { WsStatus } from './ws/client';

interface Store {
  // ---- auth ----
  token: string | null;

  // ---- session table ----
  sessions: SessionInfo[];
  activeSid: string | null;

  // ---- ws status ----
  /**
   * Status of the currently active session's ws (mirrors
   * `sessionStatuses[activeSid]`). Kept as a top-level slot for callers
   * that haven't migrated to the per-sid map.
   */
  status: WsStatus;
  /**
   * Per-sid status. Updated by `setSessionStatus` (called by
   * session-runtime.ts) whenever any session's ws transitions. Missing keys
   * mean "no runtime entry yet" and read as 'idle' at the UI layer.
   */
  sessionStatuses: Record<string, WsStatus>;

  // ---- mutators ----
  /**
   * Append a session and auto-promote it to active. Idempotent on duplicate
   * sid: if the sid is already present we just promote it without appending
   * a second row.
   */
  addSession: (s: SessionInfo) => void;
  /**
   * Switch which sid is rendered. No-op if `sid` is already active or absent
   * from the store. Refreshes `status` to whatever the new active sid's
   * runtime status is (or 'idle' if the runtime hasn't published one yet).
   */
  setActive: (sid: string | null) => void;
  /**
   * Remove a sid from the store. If the removed sid was active, promote the
   * next sibling in the list (or null if the list is now empty). Also drops
   * the per-sid status entry. NB: tearing the daemon-side PTY down + closing
   * the ws is the runtime's responsibility (Sidebar fires
   * DELETE /api/sessions/:sid + sessionRuntime.detach(sid) alongside this
   * call).
   */
  closeSession: (sid: string) => void;
  /**
   * Bulk-append sessions returned by the bootstrap GET /api/sessions call
   * (#670). Idempotent on every sid (uses `sessions.some` to dedupe), and
   * intentionally does NOT touch `activeSid` or `sessionStatuses` — the
   * user's manual selection wins, and the runtime owns ws status.
   */
  hydrateSessions: (rows: SessionInfo[]) => void;
  /**
   * @deprecated Prefer `setSessionStatus(sid, status)` so the per-sid map is
   * the source of truth. Kept so tests that pre-date T10 keep working.
   */
  setStatus: (status: WsStatus) => void;
  /**
   * Per-sid status setter — the runtime calls this on every WsStatus change.
   * If the sid is currently active, mirrors the value into the legacy
   * `status` field too.
   */
  setSessionStatus: (sid: string, status: WsStatus) => void;
}

export const useStore = create<Store>((set) => ({
  token:
    typeof window !== 'undefined'
      ? sessionStorage.getItem('ccsm.token')
      : null,
  sessions: [],
  activeSid: null,
  status: 'idle',
  sessionStatuses: {},

  addSession: (s) =>
    set((state) => {
      // Idempotency guard: if the sid is already in the table, just promote
      // it. This protects against a double-click on + New Session arriving
      // before the optimistic state update settles.
      const exists = state.sessions.some((row) => row.sid === s.sid);
      const sessions = exists ? state.sessions : [...state.sessions, s];
      const status = state.sessionStatuses[s.sid] ?? 'idle';
      return { sessions, activeSid: s.sid, status };
    }),

  setActive: (sid) =>
    set((state) => {
      if (sid === state.activeSid) return state;
      // Reject sids the store doesn't know about (defensive — would otherwise
      // leave MainPane trying to ws-attach to a phantom session).
      if (sid !== null && !state.sessions.some((row) => row.sid === sid)) {
        return state;
      }
      const status =
        sid === null ? 'idle' : (state.sessionStatuses[sid] ?? 'idle');
      return { activeSid: sid, status };
    }),

  closeSession: (sid) =>
    set((state) => {
      const idx = state.sessions.findIndex((row) => row.sid === sid);
      if (idx === -1) return state;
      const sessions = state.sessions.filter((row) => row.sid !== sid);
      let activeSid = state.activeSid;
      let status = state.status;
      if (activeSid === sid) {
        // Pick the row that took the closed session's slot, or the new tail
        // if we just removed the last row.
        if (sessions.length === 0) {
          activeSid = null;
          status = 'idle';
        } else {
          const fallback = sessions[idx] ?? sessions[sessions.length - 1];
          activeSid = fallback ? fallback.sid : null;
          status =
            activeSid === null
              ? 'idle'
              : (state.sessionStatuses[activeSid] ?? 'idle');
        }
      }
      // Drop the per-sid status entry for the closed sid so the map doesn't
      // grow unboundedly across long sessions.
      const { [sid]: _dropped, ...sessionStatuses } = state.sessionStatuses;
      void _dropped;
      return { sessions, activeSid, status, sessionStatuses };
    }),

  setStatus: (status) => set({ status }),

  hydrateSessions: (rows) =>
    set((state) => {
      // Append-only merge: skip any sid we already know about so a refetch
      // (or a duplicate row from the daemon) won't double-row the table.
      // Deliberately leave activeSid + sessionStatuses untouched: bootstrap
      // shouldn't yank focus, and ws status is owned by session-runtime.
      const fresh = rows.filter(
        (row) => !state.sessions.some((existing) => existing.sid === row.sid),
      );
      if (fresh.length === 0) return state;
      return { sessions: [...state.sessions, ...fresh] };
    }),

  setSessionStatus: (sid, status) =>
    set((state) => {
      const sessionStatuses = { ...state.sessionStatuses, [sid]: status };
      // Mirror into the legacy single-status slot only when the changed sid
      // is the active one, so existing UI keeps reflecting "the visible
      // session" without per-sid awareness.
      const next: Partial<Store> = { sessionStatuses };
      if (sid === state.activeSid) next.status = status;
      return next as Store;
    }),
}));
