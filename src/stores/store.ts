import { create } from 'zustand';
import {
  mockGroups,
  mockSessions,
  mockRecentProjects,
  activeSessionId as initialActiveId,
  type RecentProject
} from '../mock/data';
import type { Group, Session, MessageBlock } from '../types';
import { loadPersisted, schedulePersist, type PersistedState } from './persist';

export type ModelId = 'claude-opus-4' | 'claude-sonnet-4' | 'claude-haiku-4';
export type PermissionMode = 'auto' | 'ask' | 'plan';
export type Theme = 'system' | 'light' | 'dark';
export type FontSize = 'sm' | 'md' | 'lg';

type State = {
  sessions: Session[];
  groups: Group[];
  recentProjects: RecentProject[];
  activeId: string;
  focusedGroupId: string | null;
  model: ModelId;
  permission: PermissionMode;
  sidebarCollapsed: boolean;
  theme: Theme;
  fontSize: FontSize;
  messagesBySession: Record<string, MessageBlock[]>;
  startedSessions: Record<string, true>;
  runningSessions: Record<string, true>;
};

type Actions = {
  selectSession: (id: string) => void;
  focusGroup: (id: string | null) => void;
  createSession: (cwd: string | null) => void;
  renameSession: (id: string, name: string) => void;
  deleteSession: (id: string) => void;
  moveSession: (sessionId: string, targetGroupId: string, beforeSessionId: string | null) => void;
  changeCwd: (cwd: string) => void;
  pushRecentProject: (path: string) => void;
  setModel: (model: ModelId) => void;
  setPermission: (mode: PermissionMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;

  createGroup: (name?: string) => string;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => void;
  archiveGroup: (id: string) => void;
  unarchiveGroup: (id: string) => void;
  setGroupCollapsed: (id: string, collapsed: boolean) => void;

  appendBlocks: (sessionId: string, blocks: MessageBlock[]) => void;
  clearMessages: (sessionId: string) => void;
  markStarted: (sessionId: string) => void;
  setRunning: (sessionId: string, running: boolean) => void;
};

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function firstUsableGroupId(groups: Group[]): string {
  const g = groups.find((x) => x.kind === 'normal');
  return g ? g.id : groups[0]?.id ?? 'g1';
}

export const useStore = create<State & Actions>((set, get) => ({
  sessions: mockSessions.map((s) => ({ ...s })),
  groups: mockGroups.map((g) => ({ ...g })),
  recentProjects: mockRecentProjects,
  activeId: initialActiveId,
  focusedGroupId: null,
  model: 'claude-opus-4',
  permission: 'auto',
  sidebarCollapsed: false,
  theme: 'system',
  fontSize: 'md',
  messagesBySession: {},
  startedSessions: {},
  runningSessions: {},

  selectSession: (id) => {
    set((s) => ({
      activeId: id,
      focusedGroupId: null,
      sessions: s.sessions.map((x) =>
        x.id === id && x.state === 'waiting' ? { ...x, state: 'idle' } : x
      )
    }));
  },

  focusGroup: (id) => set({ focusedGroupId: id }),

  createSession: (cwd) => {
    const { sessions, groups, focusedGroupId, activeId, model } = get();
    const isUsable = (gid: string | null | undefined) => {
      if (!gid) return false;
      const g = groups.find((x) => x.id === gid);
      return !!g && g.kind === 'normal';
    };
    const activeGroupId = sessions.find((s) => s.id === activeId)?.groupId;
    const targetGroupId = isUsable(focusedGroupId)
      ? focusedGroupId!
      : isUsable(activeGroupId)
      ? activeGroupId!
      : firstUsableGroupId(groups);
    const id = nextId('s');
    const newSession: Session = {
      id,
      name: 'New session',
      state: 'idle',
      cwd: cwd ?? '~',
      model,
      groupId: targetGroupId,
      agentType: 'claude-code'
    };
    set({
      sessions: [newSession, ...sessions],
      activeId: id,
      focusedGroupId: null
    });
  },

  renameSession: (id, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x))
    }));
  },

  deleteSession: (id) => {
    set((s) => {
      const remaining = s.sessions.filter((x) => x.id !== id);
      const nextActive =
        s.activeId === id ? remaining[0]?.id ?? '' : s.activeId;
      const nextMessages = { ...s.messagesBySession };
      delete nextMessages[id];
      const nextStarted = { ...s.startedSessions };
      delete nextStarted[id];
      const nextRunning = { ...s.runningSessions };
      delete nextRunning[id];
      return {
        sessions: remaining,
        activeId: nextActive,
        messagesBySession: nextMessages,
        startedSessions: nextStarted,
        runningSessions: nextRunning
      };
    });
  },

  moveSession: (sessionId, targetGroupId, beforeSessionId) => {
    set((s) => {
      const moving = s.sessions.find((x) => x.id === sessionId);
      if (!moving) return s;
      const targetGroup = s.groups.find((g) => g.id === targetGroupId);
      if (!targetGroup) return s;
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
          sessions: [...without.slice(0, insertAt), updated, ...without.slice(insertAt)]
        };
      }
      const anchor = without.findIndex((x) => x.id === beforeSessionId);
      return {
        sessions: [...without.slice(0, anchor), updated, ...without.slice(anchor)]
      };
    });
  },

  changeCwd: (cwd) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === s.activeId ? { ...x, cwd } : x))
    }));
  },

  pushRecentProject: (p) => {
    set((s) => {
      const path = p.replace(/[\\/]+$/, '');
      if (!path) return s;
      const segs = path.split(/[\\/]/).filter(Boolean);
      const name = segs[segs.length - 1] ?? path;
      const without = s.recentProjects.filter((r) => r.path !== path);
      const id = `p-${Date.now().toString(36)}`;
      const next = [{ id, name, path }, ...without].slice(0, 8);
      return { recentProjects: next };
    });
  },

  setModel: (model) => set({ model }),
  setPermission: (permission) => set({ permission }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setTheme: (theme) => set({ theme }),
  setFontSize: (fontSize) => set({ fontSize }),

  createGroup: (name) => {
    const id = nextId('g');
    const newGroup: Group = {
      id,
      name: name ?? 'New group',
      collapsed: false,
      kind: 'normal'
    };
    set((s) => ({ groups: [...s.groups, newGroup] }));
    return id;
  },

  renameGroup: (id, name) => {
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g))
    }));
  },

  // Per design principle "don't constrain the user": deleting a group also
  // deletes its sessions. No soft-delete state in MVP — that's what archive is for.
  deleteGroup: (id) => {
    set((s) => {
      const remainingSessions = s.sessions.filter((x) => x.groupId !== id);
      const nextActive = remainingSessions.some((x) => x.id === s.activeId)
        ? s.activeId
        : remainingSessions[0]?.id ?? '';
      return {
        groups: s.groups.filter((g) => g.id !== id),
        sessions: remainingSessions,
        activeId: nextActive,
        focusedGroupId: s.focusedGroupId === id ? null : s.focusedGroupId
      };
    });
  },

  archiveGroup: (id) => {
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, kind: 'archive' } : g))
    }));
  },

  unarchiveGroup: (id) => {
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, kind: 'normal' } : g))
    }));
  },

  setGroupCollapsed: (id, collapsed) => {
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, collapsed } : g))
    }));
  },

  appendBlocks: (sessionId, blocks) => {
    if (blocks.length === 0) return;
    set((s) => {
      const prev = s.messagesBySession[sessionId] ?? [];
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: [...prev, ...blocks] }
      };
    });
  },

  clearMessages: (sessionId) => {
    set((s) => {
      if (!(sessionId in s.messagesBySession)) return s;
      const next = { ...s.messagesBySession };
      delete next[sessionId];
      return { messagesBySession: next };
    });
  },

  markStarted: (sessionId) => {
    set((s) =>
      s.startedSessions[sessionId]
        ? s
        : { startedSessions: { ...s.startedSessions, [sessionId]: true } }
    );
  },

  setRunning: (sessionId, running) => {
    set((s) => {
      const has = !!s.runningSessions[sessionId];
      if (has === running) return s;
      const next = { ...s.runningSessions };
      if (running) next[sessionId] = true;
      else delete next[sessionId];
      return { runningSessions: next };
    });
  }
}));

let hydrated = false;

export async function hydrateStore(): Promise<void> {
  if (hydrated) return;
  const persisted = await loadPersisted();
  if (persisted) {
    const stillActive = persisted.sessions.some((s) => s.id === persisted.activeId);
    useStore.setState({
      sessions: persisted.sessions,
      groups: persisted.groups,
      activeId: stillActive ? persisted.activeId : persisted.sessions[0]?.id ?? '',
      model: persisted.model,
      permission: persisted.permission,
      sidebarCollapsed: persisted.sidebarCollapsed ?? false,
      theme: persisted.theme ?? 'system',
      fontSize: persisted.fontSize ?? 'md',
      recentProjects: persisted.recentProjects ?? mockRecentProjects
    });
  }
  hydrated = true;
  // After (potential) hydration, subscribe to write-through.
  useStore.subscribe((s) => {
    const snapshot: PersistedState = {
      version: 1,
      sessions: s.sessions,
      groups: s.groups,
      activeId: s.activeId,
      model: s.model,
      permission: s.permission,
      sidebarCollapsed: s.sidebarCollapsed,
      theme: s.theme,
      fontSize: s.fontSize,
      recentProjects: s.recentProjects
    };
    schedulePersist(snapshot);
  });
}
