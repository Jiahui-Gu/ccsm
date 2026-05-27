// Session runtime slice: transient per-session state mutated by the SDK
// stream / pty bridges and the sidebar flash animation. None of this is
// persisted — fields reset to their initial empty shape on every boot.
//
// Owned actions:
//   `_applySessionState` — patch the session's `state` (idle | waiting),
//      with the rule that the *active* session never enters waiting (the
//      user's looking at it, so we don't pulse the sidebar row).
//   `_setFlash` — toggle the flash animation flag for a session row.
//   `_applyCwdRedirect` — patch a session's `cwd` when the SDK reports a
//      mid-session directory change (e.g. a tool ran `cd`).
//   `_applyPtyExit` / `_clearPtyExit` — record / clear the pty exit
//      classification (`clean | crashed`) used to badge the sidebar row.
//
// Title-related runtime mutations (`_applyExternalTitle`) and JSONL
// title-backfill live on `sessionTitleBackfillSlice`. CRUD lives on
// `sessionCrudSlice` (split per Task #736 / PR #754 review).

import { classifyPtyExit } from '../../lib/ptyExitClassifier';
import type { RootStore, SetFn, GetFn } from './types';

export type SessionRuntimeSlice = Pick<
  RootStore,
  | 'flashStates'
  | 'disconnectedSessions'
  | 'reloadNonce'
  | 'expectedExits'
  | '_applySessionState'
  | '_setFlash'
  | '_applyCwdRedirect'
  | '_applyPtyExit'
  | '_clearPtyExit'
  | 'reloadSession'
>;

export function createSessionRuntimeSlice(
  set: SetFn,
  _get: GetFn,
): SessionRuntimeSlice {
  void _get;
  return {
    // initial state
    flashStates: {},
    disconnectedSessions: {},
    reloadNonce: {},
    expectedExits: {},

    _applySessionState: (sid, state) => {
      set((s) => {
        const target =
          state === 'waiting' && sid === s.activeId ? 'idle' : state;
        let changed = false;
        const sessions = s.sessions.map((x) => {
          if (x.id !== sid) return x;
          if (x.state === target) return x;
          changed = true;
          return { ...x, state: target };
        });
        return changed ? { sessions } : {};
      });
    },

    _setFlash: (sid, on) => {
      set((s) => {
        const cur = s.flashStates[sid] === true;
        if (cur === on) return {};
        const next = { ...s.flashStates };
        if (on) next[sid] = true;
        else delete next[sid];
        return { flashStates: next };
      });
    },

    _applyCwdRedirect: (sid, newCwd) => {
      if (typeof newCwd !== 'string' || newCwd.length === 0) return;
      set((s) => {
        const idx = s.sessions.findIndex((x) => x.id === sid);
        if (idx === -1) return s;
        if (s.sessions[idx]!.cwd === newCwd) return s;
        const next = s.sessions.slice();
        next[idx] = { ...next[idx]!, cwd: newCwd };
        return { ...s, sessions: next };
      });
    },

    _applyPtyExit: (sid, payload) => {
      // Reload-race guard: `reloadSession` increments
      // `expectedExits[sid]` before issuing the kill so the OLD pty's
      // exit event (which travels through main → renderer IPC
      // asynchronously and lands AFTER reloadSession's `set()`
      // returns) doesn't show up in `disconnectedSessions` and trip
      // the "claude crashed" overlay on the freshly-spawned pty. Each
      // recorded reload swallows exactly one subsequent exit; if the
      // OLD pty had already exited before kill was called the counter
      // stays armed and quietly absorbs the next real exit instead —
      // chosen as the lesser evil vs. surfacing a bogus crash overlay
      // every time the user clicks reload on a healthy session. A
      // truly crashed reloaded session still surfaces because the
      // crash exit increments well after the suppressor has been
      // consumed by the kill's own exit event.
      const expected = (_get().expectedExits ?? {})[sid] ?? 0;
      if (expected > 0) {
        set((s) => {
          const nextExpected = { ...s.expectedExits };
          if (nextExpected[sid]! <= 1) delete nextExpected[sid];
          else nextExpected[sid] = nextExpected[sid]! - 1;
          return { expectedExits: nextExpected };
        });
        return;
      }
      const kind = classifyPtyExit({ code: payload.code, signal: payload.signal });
      set((s) => ({
        disconnectedSessions: {
          ...s.disconnectedSessions,
          [sid]: { kind, code: payload.code, signal: payload.signal, at: Date.now() },
        },
      }));
    },

    _clearPtyExit: (sid) => {
      set((s) => {
        if (!s.disconnectedSessions[sid]) return s;
        const next = { ...s.disconnectedSessions };
        delete next[sid];
        return { disconnectedSessions: next };
      });
    },

    reloadSession: async (sid) => {
      // Arm the exit-suppressor BEFORE kill: the kill's exit event will
      // land asynchronously and would otherwise pollute the
      // disconnectedSessions slice with a stale crash entry for the
      // pty we ourselves asked to die. See `_applyPtyExit` for the
      // matching consume-side.
      set((s) => ({
        expectedExits: {
          ...s.expectedExits,
          [sid]: ((s.expectedExits ?? {})[sid] ?? 0) + 1,
        },
      }));
      // Kill the current PTY (best-effort — it may already be exiting).
      try {
        await window.ccsmPty?.kill(sid);
      } catch {
        /* renderer started without preload (tests) — no-op */
      }
      // Per attach-redesign §4: reload is term.reset() in-place, NOT
      // dispose. The attach hook observes the reloadNonce bump below and
      // runs the "reset + snapshot + write + subscribe" suffix against
      // the freshly spawned PTY. Hidden-shell reloads are silent (no
      // mask); top-shell reloads show the mask while the suffix runs.
      set((s) => {
        const nextDisc = s.disconnectedSessions[sid]
          ? (() => {
              const next = { ...s.disconnectedSessions };
              delete next[sid];
              return next;
            })()
          : s.disconnectedSessions;
        const cur = s.reloadNonce[sid] ?? 0;
        return {
          disconnectedSessions: nextDisc,
          reloadNonce: { ...s.reloadNonce, [sid]: cur + 1 },
        };
      });
    },
  };
}
