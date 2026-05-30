import type { Session } from '../../types';
import { CLAUDE_CODE_AGENT_ID } from '../../shared/agentIds';
import { resolvePreferredGroup } from '../lib/preferredGroupResolver';
import {
  ensureUsableGroup,
  newSessionId,
} from '../lib/sessionCrudHelpers';
import type {
  CreateSessionOptions,
  RootStore,
  SetFn,
  GetFn,
} from './types';

export type SessionCreateSlice = Pick<
  RootStore,
  | 'sessions'
  | 'activeId'
  | 'focusedGroupId'
  | 'userHome'
  | 'claudeSettingsDefaultModel'
  | 'pendingRenameId'
  | 'pendingForkSource'
  | 'createSession'
  | 'importSession'
  | 'copySession'
>;

export function createSessionCreateSlice(set: SetFn, get: GetFn): SessionCreateSlice {
  return {
    // initial state
    sessions: [],
    activeId: '',
    focusedGroupId: null,
    userHome: '',
    claudeSettingsDefaultModel: null,
    pendingRenameId: null,
    pendingForkSource: {},

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
  };
}
