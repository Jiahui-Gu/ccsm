import type { Session } from '../../types';
import { disposeShell } from '../../terminal/shellRegistry';
import { deleteDrafts, snapshotDraft, restoreDraft } from '../drafts';
import {
  setPendingManualRename,
  clearPendingManualRename,
} from '../lib/pendingManualRenames';
import { tryEnqueuePending } from '../lib/sessionCrudHelpers';
import type {
  SessionSnapshot,
  RootStore,
  SetFn,
  GetFn,
} from './types';

export type SessionMutationSlice = Pick<
  RootStore,
  | 'selectSession'
  | 'focusGroup'
  | 'renameSession'
  | 'deleteSession'
  | 'restoreSession'
  | 'moveSession'
  | 'changeCwd'
  | 'setSessionModel'
  | 'consumePendingRename'
>;

export function createSessionMutationSlice(set: SetFn, get: GetFn): SessionMutationSlice {
  return {
    selectSession: (id) => {
      set((s) => ({
        activeId: id,
        focusedGroupId: null,
        sessions: s.sessions.map((x) =>
          x.id === id && x.state === 'waiting' ? { ...x, state: 'idle' } : x
        ),
      }));
    },

    focusGroup: (id) => set({ focusedGroupId: id }),

    renameSession: async (id, name) => {
      const session = get().sessions.find((x) => x.id === id);
      // Mark this sid as "manual rename pending SDK confirmation" before
      // the local mutation. _applyExternalTitle reads this map to drop
      // stale auto-summary patches that would otherwise overwrite the
      // user's chosen name between the JSONL rewrite and the next
      // titleEmitter tick.
      setPendingManualRename(id, name);
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x)),
      }));

      const bridge =
        typeof window !== 'undefined'
          ? (window as unknown as {
              ccsmSessionTitles?: {
                rename: (sid: string, title: string, dir?: string) =>
                  Promise<{ ok: true } | { ok: false; reason: 'no_jsonl' | 'sdk_threw'; message?: string }>;
                enqueuePending: (sid: string, title: string, dir?: string) => Promise<void>;
              };
            }).ccsmSessionTitles
          : undefined;
      if (!bridge) {
        // No bridge (jsdom/tests) — clear the guard so the slice doesn't
        // permanently swallow future external titles for this sid.
        clearPendingManualRename(id);
        return;
      }

      const dir = session?.cwd;
      try {
        const result = await bridge.rename(id, name, dir);
        if (result.ok) return;
        if (result.reason === 'no_jsonl') {
          await tryEnqueuePending(bridge, id, name, dir);
          return;
        }
        // sdk_threw: the JSONL rewrite failed. Queue a pending rename so
        // the flusher retries when the JSONL is next observed; without
        // this the renderer name and the JSONL summary stay split-brained
        // and the watcher will eventually clobber the user's choice.
        console.error(
          `[rename:writeback-failed] sid=${id} message=${result.message ?? '(no message)'}`
        );
        await tryEnqueuePending(bridge, id, name, dir);
      } catch (err) {
        console.error(`[rename:writeback-failed] ipc sid=${id}`, err);
        await tryEnqueuePending(bridge, id, name, dir);
      }
    },

    deleteSession: (id) => {
      const prev = get();
      const idx = prev.sessions.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      const target = prev.sessions[idx]!;
      const snapshot: SessionSnapshot = {
        session: target,
        index: idx,
        draft: snapshotDraft(id),
        prevActiveId: prev.activeId,
      };
      set((s) => {
        const remaining = s.sessions.filter((x) => x.id !== id);
        let nextActive = s.activeId;
        if (s.activeId === id) {
          const sourceGroupId = target.groupId;
          const sameGroup = remaining.filter((x) => x.groupId === sourceGroupId);
          if (sameGroup.length > 0) {
            const beforeIdxOrig = s.sessions
              .map((x, i) => ({ x, i }))
              .filter(({ x, i }) => x.groupId === sourceGroupId && i < idx);
            const afterIdxOrig = s.sessions
              .map((x, i) => ({ x, i }))
              .filter(({ x, i }) => x.groupId === sourceGroupId && i > idx);
            if (afterIdxOrig.length > 0) {
              nextActive = afterIdxOrig[0]!.x.id;
            } else if (beforeIdxOrig.length > 0) {
              nextActive = beforeIdxOrig[beforeIdxOrig.length - 1]!.x.id;
            } else {
              nextActive = remaining[0]?.id ?? '';
            }
          } else {
            nextActive = remaining[0]?.id ?? '';
          }
        }
        // audit #876 H2: deleteSession fan-out must drain every per-sid
        // store, not just the sessions array. Without this, flashStates
        // and disconnectedSessions accumulate entries for deleted sids
        // (the only other clear paths are PTY-exit IPC, which doesn't
        // fire for sessions that never spawned a PTY, and a re-spawn that
        // overwrites the entry — both are best-effort, not delete-time).
        const patch: Partial<RootStore> = {
          sessions: remaining,
          activeId: nextActive,
        };
        if (s.flashStates && s.flashStates[id]) {
          const next = { ...s.flashStates };
          delete next[id];
          patch.flashStates = next;
        }
        if (s.disconnectedSessions && s.disconnectedSessions[id]) {
          const next = { ...s.disconnectedSessions };
          delete next[id];
          patch.disconnectedSessions = next;
        }
        return patch;
      });
      deleteDrafts([id]);
      clearPendingManualRename(id);
      try {
        void window.ccsmPty?.kill(id).catch(() => {});
      } catch {
        /* renderer started without preload (tests) — no-op */
      }
      // attach-redesign §4: delete removes the shell. z-stack collapses
      // to the next remaining shell, or back to State 0 (blank) if empty.
      try {
        disposeShell(id);
      } catch {
        /* registry absent (tests / non-renderer contexts) — non-fatal */
      }
      return snapshot;
    },

    restoreSession: (snapshot) => {
      set((s) => {
        if (s.sessions.some((x) => x.id === snapshot.session.id)) return s;
        const insertAt = Math.min(Math.max(snapshot.index, 0), s.sessions.length);
        const sessions = [
          ...s.sessions.slice(0, insertAt),
          snapshot.session,
          ...s.sessions.slice(insertAt),
        ];
        return {
          sessions,
          activeId: snapshot.prevActiveId || s.activeId,
        };
      });
      restoreDraft(snapshot.session.id, snapshot.draft);
    },

    moveSession: (sessionId, targetGroupId, beforeSessionId) => {
      set((s) => {
        const moving = s.sessions.find((x) => x.id === sessionId);
        if (!moving) return s;
        const targetGroup = s.groups.find((g) => g.id === targetGroupId);
        if (!targetGroup) return s;
        if (targetGroup.kind !== 'normal') return s;
        const without = s.sessions.filter((x) => x.id !== sessionId);
        const updated: Session = { ...moving, groupId: targetGroupId };
        const anchorValid =
          beforeSessionId !== null &&
          without.some(
            (x) => x.id === beforeSessionId && x.groupId === targetGroupId
          );
        if (!anchorValid) {
          let lastIdx = -1;
          without.forEach((x, i) => {
            if (x.groupId === targetGroupId) lastIdx = i;
          });
          const insertAt = lastIdx === -1 ? without.length : lastIdx + 1;
          return {
            sessions: [...without.slice(0, insertAt), updated, ...without.slice(insertAt)],
          };
        }
        const anchor = without.findIndex((x) => x.id === beforeSessionId);
        return {
          sessions: [...without.slice(0, anchor), updated, ...without.slice(anchor)],
        };
      });
    },

    changeCwd: (cwd) => {
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.id === s.activeId ? { ...x, cwd, cwdMissing: false } : x
        ),
      }));
      const userHome = get().userHome;
      if (cwd && cwd !== userHome) {
        const api = window.ccsm;
        void api?.userCwds?.push(cwd).catch(() => {});
      }
    },

    setSessionModel: (sessionId, model) => {
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, model } : x)),
      }));
    },

    consumePendingRename: (sessionId) => {
      set((s) => (s.pendingRenameId === sessionId ? { pendingRenameId: null } : {}));
    },
  };
}
