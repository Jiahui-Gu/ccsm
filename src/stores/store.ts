import { create } from 'zustand';
import type { RecentProject } from '../mock/data';
import { toSdkPermissionMode } from '../agent/permission';
import type { Group, Session, MessageBlock } from '../types';
import { loadPersisted, schedulePersist, type PersistedState } from './persist';

export type ModelId = 'claude-opus-4' | 'claude-sonnet-4' | 'claude-haiku-4';
export type PermissionMode = 'plan' | 'ask' | 'auto' | 'yolo';
export type Theme = 'system' | 'light' | 'dark';
export type FontSize = 'sm' | 'md' | 'lg';

// Auto-prompt watchdog: when an agent stops without uttering the done token,
// the lifecycle replies for the user so the agent doesn't sit idle. Tunables
// live in user settings; per-session counts cap how many auto-replies fire
// before a human must actually weigh in.
export interface WatchdogConfig {
  enabled: boolean;
  doneToken: string;
  otherwisePostfix: string;
  maxAutoReplies: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  enabled: false,
  doneToken: '我真的已经做完了',
  otherwisePostfix: '继续做，别问我任何事，你来做决策。',
  maxAutoReplies: 20
};

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
  tutorialSeen: boolean;
  watchdog: WatchdogConfig;
  watchdogCountsBySession: Record<string, number>;
  messagesBySession: Record<string, MessageBlock[]>;
  startedSessions: Record<string, true>;
  runningSessions: Record<string, true>;
  // Marks sessions where the user clicked Stop. Consumed when the next
  // `result { error_during_execution }` frame arrives so we can render a
  // neutral "Interrupted" banner instead of an error block.
  interruptedSessions: Record<string, true>;
};

type Actions = {
  selectSession: (id: string) => void;
  focusGroup: (id: string | null) => void;
  createSession: (cwd: string | null) => void;
  importSession: (opts: { name: string; cwd: string; groupId: string; resumeSessionId: string }) => string;
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
  markTutorialSeen: () => void;
  setWatchdog: (patch: Partial<WatchdogConfig>) => void;
  resetWatchdogCount: (sessionId: string) => void;
  bumpWatchdogCount: (sessionId: string) => number;

  createGroup: (name?: string) => string;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => void;
  archiveGroup: (id: string) => void;
  unarchiveGroup: (id: string) => void;
  setGroupCollapsed: (id: string, collapsed: boolean) => void;

  appendBlocks: (sessionId: string, blocks: MessageBlock[]) => void;
  streamAssistantText: (sessionId: string, blockId: string, appendText: string, done: boolean) => void;
  setToolResult: (sessionId: string, toolUseId: string, result: string, isError: boolean) => void;
  clearMessages: (sessionId: string) => void;
  loadMessages: (sessionId: string) => Promise<void>;
  markStarted: (sessionId: string) => void;
  setRunning: (sessionId: string, running: boolean) => void;
  markInterrupted: (sessionId: string) => void;
  consumeInterrupted: (sessionId: string) => boolean;
  resolvePermission: (sessionId: string, requestId: string, decision: 'allow' | 'deny') => void;
};

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function firstUsableGroupId(groups: Group[]): string {
  const g = groups.find((x) => x.kind === 'normal');
  return g ? g.id : groups[0]?.id ?? 'g1';
}

// Module-scoped set tracking in-flight db fetches, so rapid re-clicks on a
// session don't issue redundant IPC round-trips.
const inFlightLoads = new Set<string>();

const defaultGroups: Group[] = [
  { id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }
];

export const useStore = create<State & Actions>((set, get) => ({
  sessions: [],
  groups: defaultGroups,
  recentProjects: [],
  activeId: '',
  focusedGroupId: null,
  model: 'claude-opus-4',
  permission: 'auto',
  sidebarCollapsed: false,
  theme: 'system',
  fontSize: 'md',
  tutorialSeen: false,
  watchdog: DEFAULT_WATCHDOG,
  watchdogCountsBySession: {},
  messagesBySession: {},
  startedSessions: {},
  runningSessions: {},
  interruptedSessions: {},

  selectSession: (id) => {
    set((s) => ({
      activeId: id,
      focusedGroupId: null,
      sessions: s.sessions.map((x) =>
        x.id === id && x.state === 'waiting' ? { ...x, state: 'idle' } : x
      )
    }));
    // Lazy-load persisted history on first view after app restart. The store
    // only holds messages in memory; on fresh boot messagesBySession[id] is
    // undefined until we fetch from the db. An empty array means "known to be
    // empty", so only fetch when the key is truly missing.
    if (id && !(id in get().messagesBySession)) {
      void get().loadMessages(id);
    }
  },

  focusGroup: (id) => set({ focusedGroupId: id }),

  createSession: (cwd) => {
    const { sessions, groups, focusedGroupId, activeId, model, recentProjects } = get();
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
    const defaultCwd = recentProjects[0]?.path ?? '~';
    const newSession: Session = {
      id,
      name: 'New session',
      state: 'idle',
      cwd: cwd ?? defaultCwd,
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

  importSession: ({ name, cwd, groupId, resumeSessionId }) => {
    const { sessions, model } = get();
    const id = nextId('s');
    const imported: Session = {
      id,
      name,
      state: 'idle',
      cwd,
      model,
      groupId,
      agentType: 'claude-code',
      resumeSessionId
    };
    set({ sessions: [imported, ...sessions], activeId: id, focusedGroupId: null });
    return id;
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
      const nextInterrupted = { ...s.interruptedSessions };
      delete nextInterrupted[id];
      return {
        sessions: remaining,
        activeId: nextActive,
        messagesBySession: nextMessages,
        startedSessions: nextStarted,
        runningSessions: nextRunning,
        interruptedSessions: nextInterrupted
      };
    });
    // Wipe the persisted rows so a deleted session can't resurrect its
    // history if a new session happens to reuse the id.
    void window.agentory?.saveMessages(id, []);
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

  setModel: (model) => {
    set({ model });
    const api = window.agentory;
    if (!api) return;
    const started = Object.keys(get().startedSessions);
    for (const id of started) void api.agentSetModel(id, model);
  },
  setPermission: (permission) => {
    set({ permission });
    const api = window.agentory;
    if (!api) return;
    const sdkMode = toSdkPermissionMode(permission);
    const started = Object.keys(get().startedSessions);
    for (const id of started) void api.agentSetPermissionMode(id, sdkMode);
  },
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setTheme: (theme) => set({ theme }),
  setFontSize: (fontSize) => set({ fontSize }),
  markTutorialSeen: () => set({ tutorialSeen: true }),

  setWatchdog: (patch) =>
    set((s) => ({ watchdog: { ...s.watchdog, ...patch } })),

  resetWatchdogCount: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.watchdogCountsBySession)) return s;
      const next = { ...s.watchdogCountsBySession };
      delete next[sessionId];
      return { watchdogCountsBySession: next };
    }),

  bumpWatchdogCount: (sessionId) => {
    const cur = get().watchdogCountsBySession[sessionId] ?? 0;
    const nextN = cur + 1;
    set((s) => ({
      watchdogCountsBySession: { ...s.watchdogCountsBySession, [sessionId]: nextN }
    }));
    return nextN;
  },

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
      // Coalesce by id: if a block with the same id already exists (e.g. an
      // assistant text block built up by streaming deltas), replace it in
      // place with the finalized version rather than duplicating it.
      let next = prev;
      const toAppend: MessageBlock[] = [];
      for (const b of blocks) {
        const idx = next.findIndex((x) => x.id === b.id);
        if (idx === -1) {
          toAppend.push(b);
        } else {
          if (next === prev) next = prev.slice();
          next[idx] = b;
        }
      }
      if (toAppend.length === 0 && next === prev) return s;
      const finalNext = toAppend.length > 0 ? [...next, ...toAppend] : next;
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: finalNext }
      };
    });
  },

  streamAssistantText: (sessionId, blockId, appendText, done) => {
    set((s) => {
      const prev = s.messagesBySession[sessionId] ?? [];
      const idx = prev.findIndex((b) => b.id === blockId);
      if (idx === -1) {
        // First delta for this content block — create it.
        const block: MessageBlock = {
          kind: 'assistant',
          id: blockId,
          text: appendText,
          streaming: !done
        };
        return {
          messagesBySession: { ...s.messagesBySession, [sessionId]: [...prev, block] }
        };
      }
      const existing = prev[idx];
      if (existing.kind !== 'assistant') return s;
      const next = prev.slice();
      next[idx] = { ...existing, text: existing.text + appendText, streaming: !done };
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next }
      };
    });
  },

  setToolResult: (sessionId, toolUseId, result, isError) => {
    set((s) => {
      const prev = s.messagesBySession[sessionId];
      if (!prev) return s;
      let changed = false;
      const next = prev.map((b) => {
        if (b.kind !== 'tool' || b.toolUseId !== toolUseId) return b;
        changed = true;
        return { ...b, result, isError };
      });
      if (!changed) return s;
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next }
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

  loadMessages: async (sessionId) => {
    const api = window.agentory;
    if (!api || typeof api.loadMessages !== 'function') return;
    if (inFlightLoads.has(sessionId)) return;
    inFlightLoads.add(sessionId);
    try {
      const rows = await api.loadMessages(sessionId);
      // Don't clobber blocks that arrived via streaming while we awaited the
      // db round-trip — if something is already there, keep it.
      set((s) => {
        if (s.messagesBySession[sessionId]) return s;
        return {
          messagesBySession: {
            ...s.messagesBySession,
            [sessionId]: rows as MessageBlock[]
          }
        };
      });
    } finally {
      inFlightLoads.delete(sessionId);
    }
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
  },

  markInterrupted: (sessionId) => {
    set((s) =>
      s.interruptedSessions[sessionId]
        ? s
        : { interruptedSessions: { ...s.interruptedSessions, [sessionId]: true } }
    );
  },

  consumeInterrupted: (sessionId) => {
    const was = !!get().interruptedSessions[sessionId];
    if (!was) return false;
    set((s) => {
      const next = { ...s.interruptedSessions };
      delete next[sessionId];
      return { interruptedSessions: next };
    });
    return true;
  },

  resolvePermission: (sessionId, requestId, decision) => {
    const waitId = `wait-${requestId}`;
    set((s) => {
      const prev = s.messagesBySession[sessionId];
      if (!prev) return s;
      const next = prev.filter((b) => b.id !== waitId);
      if (next.length === prev.length) return s;
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next }
      };
    });
    void window.agentory?.agentResolvePermission(sessionId, requestId, decision);
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
      recentProjects: persisted.recentProjects ?? [],
      tutorialSeen: persisted.tutorialSeen ?? false,
      watchdog: { ...DEFAULT_WATCHDOG, ...(persisted.watchdog ?? {}) }
    });
  }
  hydrated = true;
  // Kick off a load for the restored active session so the right pane paints
  // history immediately on boot, not on the next click.
  const active = useStore.getState().activeId;
  if (active) void useStore.getState().loadMessages(active);
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
      recentProjects: s.recentProjects,
      tutorialSeen: s.tutorialSeen,
      watchdog: s.watchdog
    };
    schedulePersist(snapshot);
  });
}
