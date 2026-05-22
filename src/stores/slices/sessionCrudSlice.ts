// Session CRUD slice: create / import / delete / restore / move /
// rename / changeCwd / setSessionModel + active selection.
//
// `ensureUsableGroup` is colocated here because the only callers are
// session creation/import — it picks (or synthesizes) a target group so
// a fresh row is always attached to a `kind === 'normal'` parent.
//
// `userHome` and `claudeSettingsDefaultModel` are read by `createSession`
// but live as initial state on this slice (sessions are the main consumer
// of those boot-seeded values).
//
// Runtime mutations (`_apply*`, flash, disconnected state) live on
// `sessionRuntimeSlice`. Title backfill / SDK-derived title sync lives on
// `sessionTitleBackfillSlice` (split per Task #736 / PR #754 review).

import type { Group, Session } from '../../types';
import { CLAUDE_CODE_AGENT_ID } from '../../shared/agentIds';
import { hydrateDrafts as _unused, deleteDrafts, snapshotDraft, restoreDraft } from '../drafts';
import { resolvePreferredGroup } from '../lib/preferredGroupResolver';
import {
  setPendingManualRename,
  clearPendingManualRename,
} from '../lib/pendingManualRenames';
import { defaultGroupName } from './groupsSlice';
import type {
  CreateSessionOptions,
  SessionSnapshot,
  RootStore,
  SetFn,
  GetFn,
} from './types';

void _unused;

// Shared wrapper for the three writeback-failure branches in `renameSession`
// (no_jsonl, sdk_threw, ipc-catch). All three need to push the manual rename
// into the main-process pending queue so the flusher retries later — and all
// three need to swallow + log any IPC error so a failed enqueue doesn't crash
// the renderer mid-rename. Inlined helper (not its own module) because it
// only has one caller and reads `bridge` from the local closure shape.
type RenameBridge = {
  enqueuePending: (sid: string, title: string, dir?: string) => Promise<void>;
};
async function tryEnqueuePending(
  bridge: RenameBridge,
  id: string,
  name: string,
  dir: string | undefined
): Promise<void> {
  try {
    await bridge.enqueuePending(id, name, dir);
  } catch (enqErr) {
    console.error(`[rename:writeback-failed] enqueue sid=${id}`, enqErr);
  }
}

function nextId(prefix: string): string {
  // Prefer crypto.randomUUID — collision-resistant across rapid in-tick
  // creation. Keep the `prefix-` shape so existing logs / DOM ids stay
  // parseable.
  const g: { crypto?: { randomUUID?: () => string } } =
    (typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { crypto?: { randomUUID?: () => string } })
      : {}) ?? {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return `${prefix}-${g.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Mint a session id using the same raw UUID format the Claude Code CLI uses
 * for its `~/.claude/projects/<project>/<sid>.jsonl` filenames. ccsm passes
 * this id to the SDK's `sessionId` option at spawn time, so the JSONL
 * transcript file name is identical to the in-app session id.
 */
function newSessionId(): string {
  const g: { crypto?: { randomUUID?: () => string } } =
    (typeof globalThis !== 'undefined'
      ? (globalThis as unknown as { crypto?: { randomUUID?: () => string } })
      : {}) ?? {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  // Fallback — synthesize a v4-shaped UUID for envs where crypto is shimmed
  // away (Node < 14.17 / locked-down sandbox / jsdom).
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const y = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${y}${hex(3)}-${hex(12)}`;
}

function firstUsableGroupId(groups: Group[]): string | null {
  const g = groups.find((x) => x.kind === 'normal');
  return g ? g.id : null;
}

/**
 * Resolve "where should the next session go?" — return either an existing
 * usable (`kind === 'normal'`) group, or synthesize a fresh one with the
 * current language's default name.
 */
function ensureUsableGroup(
  groups: Group[],
  preferredId?: string | null
): { groups: Group[]; groupId: string } {
  const isUsable = (gid: string | null | undefined): boolean => {
    if (!gid) return false;
    const g = groups.find((x) => x.id === gid);
    return !!g && g.kind === 'normal';
  };
  if (preferredId && isUsable(preferredId)) {
    return { groups, groupId: preferredId };
  }
  const fallback = firstUsableGroupId(groups);
  if (fallback) return { groups, groupId: fallback };
  const synth: Group = {
    id: nextId('g'),
    name: defaultGroupName(),
    nameKey: 'sidebar.defaultGroupName',
    collapsed: false,
    kind: 'normal',
  };
  return { groups: [synth, ...groups], groupId: synth.id };
}

export type SessionCrudSlice = Pick<
  RootStore,
  | 'sessions'
  | 'activeId'
  | 'focusedGroupId'
  | 'userHome'
  | 'claudeSettingsDefaultModel'
  | 'selectSession'
  | 'focusGroup'
  | 'createSession'
  | 'importSession'
  | 'renameSession'
  | 'deleteSession'
  | 'restoreSession'
  | 'moveSession'
  | 'changeCwd'
  | 'setSessionModel'
  | 'archiveSession'
  | 'unarchiveSession'
  | 'pendingRenameId'
  | 'pendingForkSource'
  | 'copySession'
  | 'consumePendingRename'
>;

export function createSessionCrudSlice(set: SetFn, get: GetFn): SessionCrudSlice {
  return {
    // initial state
    sessions: [],
    activeId: '',
    focusedGroupId: null,
    userHome: '',
    claudeSettingsDefaultModel: null,
    pendingRenameId: null,
    pendingForkSource: {},

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

    createSession: (cwdOrOpts) => {
      const opts: CreateSessionOptions =
        cwdOrOpts == null || typeof cwdOrOpts === 'string'
          ? { cwd: cwdOrOpts ?? null }
          : cwdOrOpts;
      const {
        sessions,
        groups,
        focusedGroupId,
        activeId,
        userHome,
        claudeSettingsDefaultModel,
      } = get();
      const activeGroupId = sessions.find((s) => s.id === activeId)?.groupId;
      const preferred = resolvePreferredGroup(
        groups,
        opts.groupId,
        focusedGroupId,
        activeGroupId,
      );
      const ensured = ensureUsableGroup(groups, preferred);
      const targetGroupId = ensured.groupId;
      const baseGroups = ensured.groups;
      const id = newSessionId();
      // Default cwd is `os.homedir()` always — no fallback chain. Per
      // PR #392 spec ("default cwd is home, no fallback chains"). The
      // chevron popover next to the `+` covers the "open in another
      // recent project" case so the default doesn't need to guess.
      const defaultCwd = userHome ?? '';
      let initialModel = '';
      if (!initialModel) initialModel = claudeSettingsDefaultModel ?? '';
      const newSession: Session = {
        id,
        name: opts.name?.trim() || 'New session',
        state: 'idle',
        cwd: opts.cwd ?? defaultCwd,
        model: initialModel,
        groupId: targetGroupId,
        agentType: CLAUDE_CODE_AGENT_ID,
      };
      const targetGroup = baseGroups.find((g) => g.id === targetGroupId);
      const nextGroups =
        targetGroup && targetGroup.collapsed
          ? baseGroups.map((g) => (g.id === targetGroupId ? { ...g, collapsed: false } : g))
          : baseGroups;
      set({
        sessions: [newSession, ...sessions],
        activeId: id,
        focusedGroupId: null,
        groups: nextGroups,
      });
      const finalCwd = newSession.cwd;
      if (finalCwd && userHome && finalCwd !== userHome) {
        const api = window.ccsm;
        void api?.userCwds?.push(finalCwd).catch(() => {});
      }
    },

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

    importSession: ({ name, cwd, groupId, resumeSessionId, projectDir: _projectDir }) => {
      const { sessions, groups, claudeSettingsDefaultModel } = get();
      const existing = sessions.find((s) => s.id === resumeSessionId);
      if (existing) {
        set({ activeId: existing.id, focusedGroupId: null });
        return existing.id;
      }
      const id = resumeSessionId;
      const initialModel = claudeSettingsDefaultModel ?? '';
      const ensured = ensureUsableGroup(groups, groupId);
      const imported: Session = {
        id,
        name,
        state: 'idle',
        cwd,
        model: initialModel,
        groupId: ensured.groupId,
        agentType: CLAUDE_CODE_AGENT_ID,
        resumeSessionId,
      };
      set({
        sessions: [imported, ...sessions],
        activeId: id,
        focusedGroupId: null,
        groups: ensured.groups,
      });
      const userHome = get().userHome;
      if (cwd && userHome && cwd !== userHome) {
        const api = window.ccsm;
        void api?.userCwds?.push(cwd).catch(() => {});
      }
      return id;
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

    archiveSession: (sessionId) => {
      // Single-session archive: find-or-create an archive container
      // keyed by the session's current source group, then move the
      // session into the container and stamp `archivedAt`. PTY keeps
      // running. The source group is left intact even if it empties —
      // archive is not delete; the empty group is still a valid drop
      // target for new sessions.
      const cur = get();
      const session = cur.sessions.find((x) => x.id === sessionId);
      if (!session) return;
      // Already archived (either in a flipped-archive group or a
      // container) — no-op.
      const currentGroup = cur.groups.find((g) => g.id === session.groupId);
      if (!currentGroup || currentGroup.kind !== 'normal') return;
      const sourceGroupId = session.groupId;
      const existing = cur.groups.find(
        (g) => g.kind === 'archive' && g.sourceGroupId === sourceGroupId
      );
      const containerId = existing ? existing.id : nextId('g');
      const now = Date.now();
      set((s) => {
        const groups = existing
          ? s.groups
          : [
              ...s.groups,
              {
                id: containerId,
                name: currentGroup.name,
                nameKey: currentGroup.nameKey,
                collapsed: false,
                kind: 'archive' as const,
                sourceGroupId,
              },
            ];
        // Direct `groupId` mutation here (instead of routing through
        // `moveSession`) is intentional: `moveSession` rejects any
        // non-`normal` target by design (it's the DnD move path for
        // user-driven reordering, which must never land in archived
        // territory). Archive flows are the one legitimate way to
        // move a session into an archive-kind group.
        const sessions = s.sessions.map((x) =>
          x.id === sessionId
            ? { ...x, groupId: containerId, archivedAt: now }
            : x
        );
        // If the archived session was active, hand activeId off to the
        // next normal-group session (mirrors deleteSession's fallback
        // behavior). Otherwise keep current activeId.
        let nextActive = s.activeId;
        if (s.activeId === sessionId) {
          const fallback = sessions.find(
            (x) =>
              x.id !== sessionId &&
              groups.find((g) => g.id === x.groupId)?.kind === 'normal'
          );
          nextActive = fallback?.id ?? '';
        }
        return { groups, sessions, activeId: nextActive };
      });
    },

    unarchiveSession: (sessionId) => {
      // Clear `archivedAt`, move back to original source group if it
      // still exists and is normal — otherwise fall back to g-default.
      // If the archive container empties after the move, delete it.
      // If the user has no active session (e.g. they just archived the
      // active one and then immediately unarchived it), restore activeId
      // to the unarchived session — completing the round-trip without
      // an orphaned empty-active-state.
      const store = get();
      const session = store.sessions.find((x) => x.id === sessionId);
      if (!session) return;
      const containerId = session.groupId;
      const container = store.groups.find((g) => g.id === containerId);
      // Only act on sessions that live inside an archive container —
      // sessions inside flipped-kind original groups are unarchived by
      // unarchiving the whole group.
      if (!container || container.kind !== 'archive' || !container.sourceGroupId) {
        return;
      }
      const origin = store.groups.find(
        (g) => g.id === container.sourceGroupId && g.kind === 'normal'
      );
      const targetGroupId = origin ? origin.id : 'g-default';
      set((s) => {
        const sessions = s.sessions.map((x) => {
          if (x.id !== sessionId) return x;
          const { archivedAt: _drop, ...rest } = x;
          void _drop;
          return { ...rest, groupId: targetGroupId };
        });
        const remainingInContainer = sessions.some(
          (x) => x.groupId === containerId
        );
        const groups = remainingInContainer
          ? s.groups
          : s.groups.filter((g) => g.id !== containerId);
        const nextActive = s.activeId === '' ? sessionId : s.activeId;
        return { groups, sessions, activeId: nextActive };
      });
    },

    copySession: (sourceId) => {
      const cur = get();
      const source = cur.sessions.find((x) => x.id === sourceId);
      if (!source) return null;
      const newId = newSessionId();
      // Place the copy in the same group as the source. If the source lives
      // in an archive container we still honor that — user can unarchive
      // afterwards. cwd/model/groupId/agentType all sourced from the
      // original; archivedAt is intentionally NOT carried over so a copy
      // never inherits a stale archive timestamp.
      const copy: Session = {
        id: newId,
        name: `${source.name} (copy)`,
        state: 'idle',
        cwd: source.cwd,
        model: source.model,
        groupId: source.groupId,
        agentType: source.agentType,
        // Inherit cwdMissing — the directory state is independent of which
        // session points at it; if it's missing for the source it's missing
        // for the copy too.
        ...(source.cwdMissing ? { cwdMissing: true as const } : {}),
      };
      // Insert the copy directly after the source so the new row appears
      // adjacent to its origin (matches Finder "Duplicate" behavior). The
      // sidebar renders sessions in order; so list-position == sidebar
      // position. activeId flips to the new id; pendingRenameId arms
      // inline rename for the matching <SessionRow>; pendingForkSource
      // carries the source's claude UUID so the very first `pty.spawn`
      // for newId becomes a `--resume <src> --fork-session --session-id
      // <new>` invocation in main.
      set((s) => {
        const idx = s.sessions.findIndex((x) => x.id === sourceId);
        const insertAt = idx === -1 ? 0 : idx + 1;
        const sessions = [
          ...s.sessions.slice(0, insertAt),
          copy,
          ...s.sessions.slice(insertAt),
        ];
        return {
          sessions,
          activeId: newId,
          focusedGroupId: null,
          pendingRenameId: newId,
          pendingForkSource: { ...s.pendingForkSource, [newId]: sourceId },
        };
      });
      return newId;
    },

    consumePendingRename: (sessionId) => {
      set((s) => (s.pendingRenameId === sessionId ? { pendingRenameId: null } : {}));
    },
  };
}
