// Sessions slice: session CRUD + active selection + LRU cwd seed +
// per-session transient state (`flashStates`, `disconnectedSessions`).
// Houses the cross-cut into the SDK title/cwd-redirect IPC bridges
// (`renameSession`, `_applyExternalTitle`, `_applyCwdRedirect`,
// `_backfillTitles`) and the pty exit classifier (`_applyPtyExit`).
//
// `ensureUsableGroup` is colocated here because the only caller is
// session creation/import — it picks (or synthesizes) a target group so a
// fresh row is always attached to a `kind === 'normal'` parent.
//
// `userHome` and `claudeSettingsDefaultModel` are read by `createSession`
// but live as initial state on this slice (sessions are the main consumer
// of those boot-seeded values).

import type { Group, Session } from '../../types';
import { hydrateDrafts as _unused, deleteDrafts, snapshotDraft, restoreDraft } from '../drafts';
import { partitionSessionsForBackfill, BACKFILL_DEFAULT_NAMES } from '../lib/sessionPartition';
import { classifyPtyExit } from '../../lib/ptyExitClassifier';
import { resolvePreferredGroup } from '../lib/preferredGroupResolver';
import { defaultGroupName } from './groupsSlice';
import type {
  CreateSessionOptions,
  SessionSnapshot,
  RootStore,
  SetFn,
  GetFn,
} from './types';

void _unused;

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

export type SessionsSlice = Pick<
  RootStore,
  | 'sessions'
  | 'activeId'
  | 'focusedGroupId'
  | 'userHome'
  | 'claudeSettingsDefaultModel'
  | 'flashStates'
  | 'lastUsedCwd'
  | 'disconnectedSessions'
  | 'selectSession'
  | 'focusGroup'
  | 'createSession'
  | 'importSession'
  | 'renameSession'
  | '_applyExternalTitle'
  | '_applySessionState'
  | '_setFlash'
  | '_applyCwdRedirect'
  | '_applyPtyExit'
  | '_clearPtyExit'
  | '_backfillTitles'
  | 'deleteSession'
  | 'restoreSession'
  | 'moveSession'
  | 'changeCwd'
  | 'setSessionModel'
>;

export function createSessionsSlice(set: SetFn, get: GetFn): SessionsSlice {
  return {
    // initial state
    sessions: [],
    activeId: '',
    focusedGroupId: null,
    userHome: '',
    claudeSettingsDefaultModel: null,
    flashStates: {},
    lastUsedCwd: null,
    disconnectedSessions: {},

    selectSession: (id) => {
      set((s) => ({
        activeId: id,
        focusedGroupId: null,
        sessions: s.sessions.map((x) =>
          x.id === id && x.state === 'waiting' ? { ...x, state: 'idle' } : x
        ),
      }));
    },

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
        lastUsedCwd,
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
      const defaultCwd = lastUsedCwd ?? userHome ?? '';
      let initialModel = '';
      if (!initialModel) initialModel = claudeSettingsDefaultModel ?? '';
      const newSession: Session = {
        id,
        name: opts.name?.trim() || 'New session',
        state: 'idle',
        cwd: opts.cwd ?? defaultCwd,
        model: initialModel,
        groupId: targetGroupId,
        agentType: 'claude-code',
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
        void api?.userCwds?.push(finalCwd)
          .then((list) => {
            if (Array.isArray(list) && list.length > 0) {
              set({ lastUsedCwd: list[0] ?? null });
            }
          })
          .catch(() => {});
        if (finalCwd !== lastUsedCwd) set({ lastUsedCwd: finalCwd });
      }
    },

    renameSession: async (id, name) => {
      const session = get().sessions.find((x) => x.id === id);
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
      if (!bridge) return;

      const dir = session?.cwd;
      try {
        const result = await bridge.rename(id, name, dir);
        if (result.ok) return;
        if (result.reason === 'no_jsonl') {
          await bridge.enqueuePending(id, name, dir);
          return;
        }
        console.error(
          `[rename:writeback-failed] sid=${id} message=${result.message ?? '(no message)'}`
        );
      } catch (err) {
        console.error(`[rename:writeback-failed] ipc sid=${id}`, err);
      }
    },

    _applyExternalTitle: (sid, title) => {
      set((s) => {
        const idx = s.sessions.findIndex((x) => x.id === sid);
        if (idx === -1) return s;
        if (s.sessions[idx].name === title) return s;
        const next = s.sessions.slice();
        next[idx] = { ...next[idx], name: title };
        return { ...s, sessions: next };
      });
    },

    _applyCwdRedirect: (sid, newCwd) => {
      if (typeof newCwd !== 'string' || newCwd.length === 0) return;
      set((s) => {
        const idx = s.sessions.findIndex((x) => x.id === sid);
        if (idx === -1) return s;
        if (s.sessions[idx].cwd === newCwd) return s;
        const next = s.sessions.slice();
        next[idx] = { ...next[idx], cwd: newCwd };
        return { ...s, sessions: next };
      });
    },

    _applyPtyExit: (sid, payload) => {
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

    _backfillTitles: async () => {
      type Bridge = {
        listForProject: (projectKey: string) => Promise<Array<{
          sid: string;
          summary: string | null;
          mtime: number;
        }>>;
      };
      const bridge =
        typeof window !== 'undefined'
          ? (window as unknown as { ccsmSessionTitles?: Bridge }).ccsmSessionTitles
          : undefined;
      if (!bridge || typeof bridge.listForProject !== 'function') return;

      const byProject = partitionSessionsForBackfill(get().sessions);
      if (byProject.size === 0) return;

      await Promise.all(
        Array.from(byProject.entries()).map(async ([projectKey, sids]) => {
          let summaries: Array<{ sid: string; summary: string | null; mtime: number }>;
          try {
            summaries = await bridge.listForProject(projectKey);
          } catch (err) {
            console.warn('[store._backfillTitles] listForProject failed for', projectKey, err);
            return;
          }
          if (!Array.isArray(summaries)) return;
          const summaryMap = new Map<string, string | null>();
          for (const entry of summaries) {
            if (entry && typeof entry.sid === 'string') {
              summaryMap.set(entry.sid, entry.summary);
            }
          }
          const apply = get()._applyExternalTitle;
          for (const sid of sids) {
            const sum = summaryMap.get(sid);
            if (typeof sum === 'string' && sum.length > 0) {
              const current = get().sessions.find((s) => s.id === sid);
              if (current && BACKFILL_DEFAULT_NAMES.has(current.name)) {
                apply(sid, sum);
              }
            }
          }
        })
      );
    },

    importSession: ({ name, cwd, groupId, resumeSessionId, projectDir: _projectDir }) => {
      const { sessions, groups, models, connection } = get();
      const existing = sessions.find((s) => s.id === resumeSessionId);
      if (existing) {
        set({ activeId: existing.id, focusedGroupId: null });
        return existing.id;
      }
      const id = resumeSessionId;
      let initialModel = connection?.model ?? '';
      if (!initialModel) initialModel = models[0]?.id ?? '';
      const ensured = ensureUsableGroup(groups, groupId);
      const imported: Session = {
        id,
        name,
        state: 'idle',
        cwd,
        model: initialModel,
        groupId: ensured.groupId,
        agentType: 'claude-code',
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
        void api?.userCwds?.push(cwd)
          .then((list) => {
            if (Array.isArray(list) && list.length > 0) {
              set({ lastUsedCwd: list[0] ?? null });
            }
          })
          .catch(() => {});
        if (cwd !== get().lastUsedCwd) set({ lastUsedCwd: cwd });
      }
      return id;
    },

    deleteSession: (id) => {
      const prev = get();
      const idx = prev.sessions.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      const target = prev.sessions[idx];
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
              nextActive = afterIdxOrig[0].x.id;
            } else if (beforeIdxOrig.length > 0) {
              nextActive = beforeIdxOrig[beforeIdxOrig.length - 1].x.id;
            } else {
              nextActive = remaining[0]?.id ?? '';
            }
          } else {
            nextActive = remaining[0]?.id ?? '';
          }
        }
        return {
          sessions: remaining,
          activeId: nextActive,
        };
      });
      deleteDrafts([id]);
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
        void api?.userCwds?.push(cwd)
          .then((list) => {
            if (Array.isArray(list) && list.length > 0) {
              set({ lastUsedCwd: list[0] ?? null });
            }
          })
          .catch(() => {});
        if (cwd !== get().lastUsedCwd) set({ lastUsedCwd: cwd });
      }
    },

    setSessionModel: (sessionId, model) => {
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, model } : x)),
      }));
    },
  };
}
