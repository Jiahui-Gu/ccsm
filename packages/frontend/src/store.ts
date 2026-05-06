// Zustand store for the multi-session frontend (Task #656 / T9 — DESIGN.md
// §7 + §10).
//
// SCOPE — what T9 owns:
//   - Holds a flat list of `SessionInfo` (sid + createdAt + alive flag) plus a
//     single `activeSid` pointer. Sidebar renders the list under a "default"
//     group (groups themselves are MVP-deferred); MainPane reacts to
//     `activeSid` changes by tearing the ws + xterm down and rebuilding for
//     the new sid.
//   - Bootstrap-friendly: `addSession()` auto-promotes the new session to
//     active so the existing single-session UX (T6: open page → session
//     attached) keeps working without any caller-side state machine.
//   - `closeSession()` rotates `activeSid` to the next sibling in the list
//     (or null if empty), which is what the sidebar X-button needs.
//
// EXPLICITLY OUT OF SCOPE:
//   - Real groups (rename/move/multi-group) — DESIGN.md §7 reserves this for
//     post-MVP; the sidebar renders a fixed "default" group only.
//   - Per-session scrollback / background ws — that is T10 (#662). T9 keeps
//     a single ws connection in MainPane; switching activeSid drops the old
//     connection and opens a new one. Switched-away scrollback is lost,
//     which is the documented T9 trade-off.
//   - Persistence (sessionStorage / localStorage of the session list).
//     Reload reverts to a fresh list — daemon is the source of truth (T9
//     does not yet call GET /api/sessions on boot; that is left to T10
//     once scrollback restoration matters).

import type { SessionInfo } from '@ccsm/shared';
import { create } from 'zustand';
import type { WsStatus } from './ws/client';

interface Store {
  // ---- auth ----
  token: string | null;

  // ---- session table ----
  sessions: SessionInfo[];
  activeSid: string | null;

  // ---- ws status of the *currently active* session (single-ws model) ----
  status: WsStatus;

  // ---- mutators ----
  /**
   * Append a session and auto-promote it to active. Called by the bootstrap
   * path in MainPane (when the list starts empty) and by the sidebar's
   * + New Session button. Idempotent on duplicate sid: if the sid is already
   * present we just promote it without appending a second row.
   */
  addSession: (s: SessionInfo) => void;
  /**
   * Switch which sid is rendered. No-op if `sid` is already active or absent
   * from the store.
   */
  setActive: (sid: string | null) => void;
  /**
   * Remove a sid from the store. If the removed sid was active, promote the
   * next sibling in the list (or null if the list is now empty).
   * NB: this only mutates client state — actually telling the daemon to
   * tear the PTY down is the caller's responsibility (sidebar fires
   * DELETE /api/sessions/:sid alongside this call).
   */
  closeSession: (sid: string) => void;
  setStatus: (status: WsStatus) => void;
}

export const useStore = create<Store>((set) => ({
  token:
    typeof window !== 'undefined'
      ? sessionStorage.getItem('ccsm.token')
      : null,
  sessions: [],
  activeSid: null,
  status: 'idle',

  addSession: (s) =>
    set((state) => {
      // Idempotency guard: if the sid is already in the table, just promote
      // it. This protects against a double-click on + New Session arriving
      // before the optimistic state update settles.
      const exists = state.sessions.some((row) => row.sid === s.sid);
      const sessions = exists ? state.sessions : [...state.sessions, s];
      return { sessions, activeSid: s.sid };
    }),

  setActive: (sid) =>
    set((state) => {
      if (sid === state.activeSid) return state;
      // Reject sids the store doesn't know about (defensive — would otherwise
      // leave MainPane trying to ws-attach to a phantom session).
      if (sid !== null && !state.sessions.some((row) => row.sid === sid)) {
        return state;
      }
      return { activeSid: sid };
    }),

  closeSession: (sid) =>
    set((state) => {
      const idx = state.sessions.findIndex((row) => row.sid === sid);
      if (idx === -1) return state;
      const sessions = state.sessions.filter((row) => row.sid !== sid);
      let activeSid = state.activeSid;
      if (activeSid === sid) {
        // Pick the row that took the closed session's slot, or the new tail
        // if we just removed the last row.
        if (sessions.length === 0) {
          activeSid = null;
        } else {
          const fallback = sessions[idx] ?? sessions[sessions.length - 1];
          activeSid = fallback ? fallback.sid : null;
        }
      }
      return { sessions, activeSid };
    }),

  setStatus: (status) => set({ status }),
}));
