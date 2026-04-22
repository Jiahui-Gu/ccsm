import { create } from 'zustand';
import type { RecentProject } from '../mock/data';
import type { Group, Session, MessageBlock, ImageAttachment } from '../types';
import { loadPersisted, schedulePersist, type PersistedState } from './persist';

/**
 * One pending user turn waiting in the per-session FIFO queue. Created when
 * the user hits Send while the agent is mid-turn (CLI-style queueing). Drained
 * by lifecycle.ts when the running flag flips back to false. Slash commands
 * are NOT queued — see InputBar.send() for the rationale.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: ImageAttachment[];
}

export type ModelId = string;
// Values match the CLI's `--permission-mode` flag 1:1 so we can pass the enum
// value straight through to claude.exe without a translation table. The CLI
// also accepts `auto` (classifier-driven research-preview, gated on
// Sonnet 4.6+ / account flag) and `dontAsk` (legacy alias for `default`). We
// intentionally do NOT expose either here: `auto` requires capabilities users
// can't self-enable today and would collide with our old UI value of the same
// name; `dontAsk` is legacy and redundant.
export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';
export type Theme = 'system' | 'light' | 'dark';
/**
 * Legacy categorical font size (`sm`/`md`/`lg`) — kept for persistence back-
 * compat. New code should read `fontSizePx` instead. `migrateFontSize()`
 * maps old values to pixels during hydration.
 */
export type FontSize = 'sm' | 'md' | 'lg';
/** Root font-size in px. One of 12/13/14/15/16. */
export type FontSizePx = 12 | 13 | 14 | 15 | 16;
/** UI density — drives row padding / line height / block spacing via
 * `--density-scale` CSS variable. Compact = tighter, Comfortable = airier. */
export type Density = 'compact' | 'normal' | 'comfortable';

export type EndpointKind =
  | 'anthropic'
  | 'openai-compat'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'unknown';
export type ModelSource =
  | 'settings'
  | 'env'
  | 'manual'
  | 'cli-picker'
  | 'env-override'
  | 'fallback';

// Cumulative cost / token / turn counters for a single session. Aggregated
// from `result` frames as they arrive (see agent/lifecycle). Used by the
// `/cost` client handler and could drive a future footer chip.
export interface SessionStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const EMPTY_SESSION_STATS: SessionStats = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0
};

export interface DiscoveredModel {
  id: string;
  source: ModelSource;
}

export interface ConnectionInfo {
  baseUrl: string | null;
  model: string | null;
  hasAuthToken: boolean;
}

// OS-level notification preferences. Persisted as a single JSON blob alongside
// the rest of app state.
export interface NotificationSettings {
  enabled: boolean;
  permission: boolean;
  question: boolean;
  turnDone: boolean;
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  permission: true,
  question: true,
  turnDone: true,
  sound: true
};

// First-run gate: we block session spawn until we've confirmed the Claude CLI
// exists on the user's machine. The dialog is non-dismissable but can be
// "canceled" into a persistent banner; both re-open via the same store action.
export type CliStatus =
  | { state: 'checking' }
  | { state: 'found'; binaryPath: string; version: string | null }
  | { state: 'missing'; searchedPaths: string[]; dialogOpen: boolean }
  | { state: 'configuring'; binaryPath?: string; version?: string | null };

const DEFAULT_CLI_STATUS: CliStatus = { state: 'checking' };

// Soft minimum — we log a console warning below this and surface it in the
// wizard, but we do NOT block the user. Tested locally with claude 2.0.x
// through 2.1.x; anything older than this should still spawn fine but has
// observable stream-json quirks.
export const CLI_MIN_VERSION_SOFT = '2.1.0';

function parseSemver(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isVersionBelow(actual: string | null, floor: string): boolean {
  const a = parseSemver(actual);
  const f = parseSemver(floor);
  if (!a || !f) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] < f[i]) return true;
    if (a[i] > f[i]) return false;
  }
  return false;
}

type State = {
  sessions: Session[];
  groups: Group[];
  recentProjects: RecentProject[];
  /**
   * Recent cwds derived from CLI transcripts at boot — fallback for fresh
   * userData where `recentProjects` is empty. Not persisted; rederived each
   * boot from `~/.claude/projects` via `window.agentory.recentCwds()`.
   */
  historyRecentCwds: string[];
  /**
   * Most-used model across recent CLI transcripts. Same rationale as
   * `historyRecentCwds` — seeds the new-session model picker on fresh
   * userData. Null until the boot scan resolves or if undeterminable.
   */
  historyTopModel: string | null;
  activeId: string;
  focusedGroupId: string | null;
  model: ModelId;
  permission: PermissionMode;
  sidebarCollapsed: boolean;
  /**
   * Sidebar width in pixels. Persisted as px (not %) — for a fixed-content
   * sidebar this is the unit users actually have intuition for, and avoids
   * the "sidebar mysteriously grew/shrank when I docked the window" trap of
   * percentage-based persistence. Clamped at runtime to [SIDEBAR_WIDTH_MIN,
   * SIDEBAR_WIDTH_MAX] in `setSidebarWidth`.
   */
  sidebarWidth: number;
  theme: Theme;
  fontSize: FontSize;
  fontSizePx: FontSizePx;
  density: Density;
  tutorialSeen: boolean;
  notificationSettings: NotificationSettings;
  messagesBySession: Record<string, MessageBlock[]>;
  startedSessions: Record<string, true>;
  runningSessions: Record<string, true>;
  statsBySession: Record<string, SessionStats>;
  // Marks sessions where the user clicked Stop. Consumed when the next
  // `result { error_during_execution }` frame arrives so we can render a
  // neutral "Interrupted" banner instead of an error block.
  interruptedSessions: Record<string, true>;
  /**
   * Per-session FIFO of user messages enqueued while the agent was running.
   * Drained one-at-a-time when `runningSessions[id]` flips false (see
   * `agent/lifecycle.ts`). Cleared on Stop, on session delete, and after
   * each successful drain. Not persisted — queues are an in-memory UX
   * affordance, not durable state.
   */
  messageQueues: Record<string, QueuedMessage[]>;
  models: DiscoveredModel[];
  modelsLoaded: boolean;
  connection: ConnectionInfo | null;
  // Monotonic counter bumped whenever a user-driven action requests that the
  // InputBar textarea take focus (e.g. clicking a session in the sidebar,
  // matching Claude Desktop's behavior). InputBar `useEffect`s on this and
  // calls `.focus()`. Initial value is 0 so first-render comparisons are
  // trivial — InputBar skips the first observation to avoid stealing focus
  // on app mount. Don't bump from background/system events; only user clicks.
  focusInputNonce: number;
  cliStatus: CliStatus;
};

export interface CreateSessionOptions {
  cwd?: string | null;
  name?: string;
  /** Force the new session into this group, overriding the
   *  focused/active-group fallback chain. Ignored if the id doesn't
   *  resolve to a normal (non-special) group. */
  groupId?: string;
}

type Actions = {
  selectSession: (id: string) => void;
  focusGroup: (id: string | null) => void;
  createSession: (cwd: string | null | CreateSessionOptions) => void;
  importSession: (opts: { name: string; cwd: string; groupId: string; resumeSessionId: string }) => string;
  renameSession: (id: string, name: string) => void;
  deleteSession: (id: string) => void;
  moveSession: (sessionId: string, targetGroupId: string, beforeSessionId: string | null) => void;
  changeCwd: (cwd: string) => void;
  /** Tag/untag a session whose `cwd` has been detected as missing on disk.
   *  Set true by `agent:start` when the spawn would fail with ENOENT, and
   *  cleared automatically by `changeCwd` when the user repicks. */
  markSessionCwdMissing: (sessionId: string, missing: boolean) => void;
  pushRecentProject: (path: string) => void;
  setModel: (model: ModelId) => void;
  setPermission: (mode: PermissionMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  setFontSizePx: (px: FontSizePx) => void;
  setDensity: (density: Density) => void;
  setSidebarWidth: (px: number) => void;
  resetSidebarWidth: () => void;
  markTutorialSeen: () => void;
  setNotificationSettings: (patch: Partial<NotificationSettings>) => void;
  setSessionNotificationsMuted: (sessionId: string, muted: boolean) => void;

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
  /** Wipe everything that pins a session to a specific claude.exe conversation
   *  (transcript, queue, started/running/interrupted flags, stats, resume id)
   *  WITHOUT removing the session row itself. After this runs the next user
   *  message triggers a fresh `agentStart` with no `--resume` — exactly what
   *  the CLI's `/clear` does. The Session entity (id, name, group, cwd) is
   *  preserved so the sidebar count is unchanged. */
  resetSessionContext: (sessionId: string) => void;
  replaceMessages: (sessionId: string, blocks: MessageBlock[]) => void;
  loadMessages: (sessionId: string) => Promise<void>;
  markStarted: (sessionId: string) => void;
  setRunning: (sessionId: string, running: boolean) => void;
  setSessionState: (sessionId: string, state: Session['state']) => void;
  markInterrupted: (sessionId: string) => void;
  consumeInterrupted: (sessionId: string) => boolean;
  enqueueMessage: (sessionId: string, msg: Omit<QueuedMessage, 'id'>) => void;
  dequeueMessage: (sessionId: string) => QueuedMessage | undefined;
  clearQueue: (sessionId: string) => void;
  resolvePermission: (sessionId: string, requestId: string, decision: 'allow' | 'deny') => void;
  /** Increment `focusInputNonce` to ask the InputBar to take focus. Use after
   *  any user-driven action in the chat stream that should return focus to the
   *  composer (question submit, etc.). Permission/plan paths bump implicitly
   *  via `resolvePermission`. */
  bumpComposerFocus: () => void;
  addSessionStats: (sessionId: string, delta: Partial<SessionStats>) => void;

  loadModels: () => Promise<void>;
  loadConnection: () => Promise<void>;

  checkCli: () => Promise<void>;
  setCliMissing: (searchedPaths: string[]) => void;
  openCliDialog: () => void;
  closeCliDialog: () => void;
};

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// One-shot migration for persisted permission values. Legacy builds wrote
// `standard` / `ask` / `auto` / `yolo` into the JSON blob; map them to the
// official CLI names so no user sees an "undefined" permission chip after
// upgrading. Unknown strings coerce to `default`.
export function migratePermission(raw: unknown): PermissionMode {
  switch (raw) {
    case 'plan':
    case 'default':
    case 'acceptEdits':
    case 'bypassPermissions':
      return raw;
    case 'standard':
    case 'ask':
      return 'default';
    // Legacy `auto` was our alias for `acceptEdits`, NOT the CLI's
    // classifier-driven `auto`. Migrate to what the user actually had.
    case 'auto':
      return 'acceptEdits';
    case 'yolo':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

function firstUsableGroupId(groups: Group[]): string {
  const g = groups.find((x) => x.kind === 'normal');
  return g ? g.id : groups[0]?.id ?? 'g1';
}

// ── Appearance helpers ──────────────────────────────────────────────────────

/** Map the legacy `sm`/`md`/`lg` enum to the numeric pixel scale. The old
 * values kept only three stops (12/13/14); the new slider exposes 12–16.
 * `md` → 14 intentionally (new default), not 13 — we're rebalancing the
 * whole scale to match Inter's optical size sweet spot. */
export function legacyFontSizeToPx(v: FontSize): FontSizePx {
  switch (v) {
    case 'sm': return 12;
    case 'md': return 14;
    case 'lg': return 16;
  }
}

/** Inverse — used when the user drags the new slider and we want the legacy
 * `fontSize` field to stay consistent (older code paths still read it). */
export function pxToLegacyFontSize(px: FontSizePx): FontSize {
  if (px <= 12) return 'sm';
  if (px >= 16) return 'lg';
  return 'md';
}

export function sanitizeFontSizePx(raw: unknown): FontSizePx {
  const n = typeof raw === 'number' ? Math.round(raw) : NaN;
  if (n === 12 || n === 13 || n === 14 || n === 15 || n === 16) return n;
  return 14;
}

export function sanitizeDensity(raw: unknown): Density {
  if (raw === 'compact' || raw === 'normal' || raw === 'comfortable') return raw;
  return 'normal';
}

export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;

export function sanitizeSidebarWidth(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(n)));
}

// Older builds persisted sidebar width as a fraction of window width
// (`sidebarWidthPct`). Convert any leftover value to px on first hydration
// after upgrade so the user's prior layout choice survives the unit change.
export function resolvePersistedSidebarWidth(persisted: {
  sidebarWidth?: number;
  sidebarWidthPct?: number;
}): number {
  if (typeof persisted.sidebarWidth === 'number') {
    return sanitizeSidebarWidth(persisted.sidebarWidth);
  }
  if (typeof persisted.sidebarWidthPct === 'number') {
    const winWidth =
      typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 1440;
    return sanitizeSidebarWidth(persisted.sidebarWidthPct * winWidth);
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

/** Resolve `theme` + OS signal to the actual rendered theme. Exported so
 * tests can lock OS state. `osPrefersDark` is the value of
 * `matchMedia('(prefers-color-scheme: dark)').matches` at call time. */
export function resolveEffectiveTheme(
  theme: Theme,
  osPrefersDark: boolean
): 'light' | 'dark' {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  return osPrefersDark ? 'dark' : 'light';
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
  historyRecentCwds: [],
  historyTopModel: null,
  activeId: '',
  focusedGroupId: null,
  model: '',
  permission: 'default',
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  theme: 'system',
  fontSize: 'md',
  fontSizePx: 14,
  density: 'normal',
  tutorialSeen: false,
  notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  messagesBySession: {},
  startedSessions: {},
  runningSessions: {},
  statsBySession: {},
  interruptedSessions: {},
  messageQueues: {},
  models: [],
  modelsLoaded: false,
  connection: null,
  focusInputNonce: 0,
  cliStatus: DEFAULT_CLI_STATUS,

  selectSession: (id) => {
    set((s) => ({
      activeId: id,
      focusedGroupId: null,
      sessions: s.sessions.map((x) =>
        x.id === id && x.state === 'waiting' ? { ...x, state: 'idle' } : x
      ),
      // Bump so the InputBar pulls focus — matches Claude Desktop's UX
      // when clicking a session in the sidebar. Other entry points that
      // ultimately route through selectSession (tray/notification click,
      // command palette) get the same behavior for free.
      focusInputNonce: s.focusInputNonce + 1
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
      model,
      recentProjects,
      historyRecentCwds,
      historyTopModel,
      models,
      connection,
    } = get();
    const isUsable = (gid: string | null | undefined) => {
      if (!gid) return false;
      const g = groups.find((x) => x.id === gid);
      return !!g && g.kind === 'normal';
    };
    const activeGroupId = sessions.find((s) => s.id === activeId)?.groupId;
    const targetGroupId = isUsable(opts.groupId)
      ? opts.groupId!
      : isUsable(focusedGroupId)
      ? focusedGroupId!
      : isUsable(activeGroupId)
      ? activeGroupId!
      : firstUsableGroupId(groups);
    const id = nextId('s');
    const defaultCwd =
      recentProjects[0]?.path ?? historyRecentCwds[0] ?? '~';
    let initialModel = model;
    if (!initialModel) initialModel = historyTopModel ?? '';
    if (!initialModel) initialModel = connection?.model ?? '';
    if (!initialModel) initialModel = models[0]?.id ?? '';
    const newSession: Session = {
      id,
      name: opts.name?.trim() || 'New session',
      state: 'idle',
      cwd: opts.cwd ?? defaultCwd,
      model: initialModel,
      groupId: targetGroupId,
      agentType: 'claude-code',
    };
    // If the target group is currently collapsed, expand it in the same
    // atomic update so the new row is visible the moment activeId flips.
    // Bumping focusInputNonce here mirrors selectSession — clicking
    // "New Session" should also land focus in the composer.
    const targetGroup = groups.find((g) => g.id === targetGroupId);
    const nextGroups =
      targetGroup && targetGroup.collapsed
        ? groups.map((g) => (g.id === targetGroupId ? { ...g, collapsed: false } : g))
        : groups;
    set((s) => ({
      sessions: [newSession, ...sessions],
      activeId: id,
      focusedGroupId: null,
      groups: nextGroups,
      focusInputNonce: s.focusInputNonce + 1
    }));
  },

  renameSession: (id, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x))
    }));
  },

  importSession: ({ name, cwd, groupId, resumeSessionId }) => {
    const { sessions, model, models, connection } = get();
    const id = nextId('s');
    let initialModel = model;
    if (!initialModel) initialModel = connection?.model ?? '';
    if (!initialModel) initialModel = models[0]?.id ?? '';
    const imported: Session = {
      id,
      name,
      state: 'idle',
      cwd,
      model: initialModel,
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
      const nextQueues = { ...s.messageQueues };
      delete nextQueues[id];
      return {
        sessions: remaining,
        activeId: nextActive,
        messagesBySession: nextMessages,
        startedSessions: nextStarted,
        runningSessions: nextRunning,
        interruptedSessions: nextInterrupted,
        messageQueues: nextQueues
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
      sessions: s.sessions.map((x) =>
        x.id === s.activeId ? { ...x, cwd, cwdMissing: false } : x
      )
    }));
  },

  markSessionCwdMissing: (sessionId, missing) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, cwdMissing: missing } : x
      )
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
    set((s) => ({
      model,
      sessions: s.sessions.map((x) => (x.id === s.activeId ? { ...x, model } : x))
    }));
    const api = window.agentory;
    if (!api) return;
    const activeId = get().activeId;
    if (activeId && get().startedSessions[activeId]) {
      void api.agentSetModel(activeId, model);
    }
  },
  setPermission: (permission) => {
    set({ permission });
    const api = window.agentory;
    if (!api) return;
    // The enum value IS the CLI flag value — no translation needed.
    const started = Object.keys(get().startedSessions);
    for (const id of started) void api.agentSetPermissionMode(id, permission);
  },
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setTheme: (theme) => set({ theme }),
  setFontSize: (fontSize) => set({ fontSize, fontSizePx: legacyFontSizeToPx(fontSize) }),
  setFontSizePx: (fontSizePx) => set({ fontSizePx, fontSize: pxToLegacyFontSize(fontSizePx) }),
  setDensity: (density) => set({ density }),
  setSidebarWidth: (px) => set({ sidebarWidth: sanitizeSidebarWidth(px) }),
  resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT }),
  markTutorialSeen: () => set({ tutorialSeen: true }),

  setNotificationSettings: (patch) =>
    set((s) => ({ notificationSettings: { ...s.notificationSettings, ...patch } })),

  setSessionNotificationsMuted: (sessionId, muted) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, notificationsMuted: muted } : x
      )
    })),

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

  resetSessionContext: (sessionId) => {
    set((s) => {
      // Bail early if the session vanished (race against deleteSession).
      if (!s.sessions.some((x) => x.id === sessionId)) return s;
      const nextMessages = { ...s.messagesBySession };
      delete nextMessages[sessionId];
      const nextStarted = { ...s.startedSessions };
      delete nextStarted[sessionId];
      const nextRunning = { ...s.runningSessions };
      delete nextRunning[sessionId];
      const nextInterrupted = { ...s.interruptedSessions };
      delete nextInterrupted[sessionId];
      const nextQueues = { ...s.messageQueues };
      delete nextQueues[sessionId];
      const nextStats = { ...s.statsBySession };
      delete nextStats[sessionId];
      // Drop resumeSessionId so the next agentStart spawns a fresh
      // claude.exe conversation rather than continuing the old one.
      const nextSessions = s.sessions.map((x) => {
        if (x.id !== sessionId || x.resumeSessionId === undefined) return x;
        const { resumeSessionId: _drop, ...rest } = x;
        return rest as typeof x;
      });
      return {
        sessions: nextSessions,
        messagesBySession: nextMessages,
        startedSessions: nextStarted,
        runningSessions: nextRunning,
        interruptedSessions: nextInterrupted,
        messageQueues: nextQueues,
        statsBySession: nextStats
      };
    });
    // Wipe persisted transcript so a reload doesn't resurrect history.
    void window.agentory?.saveMessages(sessionId, []);
  },

  replaceMessages: (sessionId, blocks) => {
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: blocks }
    }));
  },

  addSessionStats: (sessionId, delta) => {
    set((s) => {
      const prev = s.statsBySession[sessionId] ?? EMPTY_SESSION_STATS;
      const next: SessionStats = {
        turns: prev.turns + (delta.turns ?? 0),
        inputTokens: prev.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (delta.outputTokens ?? 0),
        costUsd: prev.costUsd + (delta.costUsd ?? 0)
      };
      return { statsBySession: { ...s.statsBySession, [sessionId]: next } };
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

  setSessionState: (sessionId, state) => {
    set((s) => {
      let changed = false;
      const next = s.sessions.map((x) => {
        if (x.id !== sessionId || x.state === state) return x;
        changed = true;
        return { ...x, state };
      });
      return changed ? { sessions: next } : s;
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

  enqueueMessage: (sessionId, msg) => {
    const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => {
      const prev = s.messageQueues[sessionId] ?? [];
      return {
        messageQueues: {
          ...s.messageQueues,
          [sessionId]: [...prev, { id, ...msg }]
        }
      };
    });
  },

  dequeueMessage: (sessionId) => {
    const queue = get().messageQueues[sessionId];
    if (!queue || queue.length === 0) return undefined;
    const head = queue[0];
    set((s) => {
      const cur = s.messageQueues[sessionId];
      if (!cur || cur.length === 0) return s;
      const rest = cur.slice(1);
      const next = { ...s.messageQueues };
      if (rest.length === 0) delete next[sessionId];
      else next[sessionId] = rest;
      return { messageQueues: next };
    });
    return head;
  },

  clearQueue: (sessionId) => {
    set((s) => {
      if (!s.messageQueues[sessionId]) return s;
      const next = { ...s.messageQueues };
      delete next[sessionId];
      return { messageQueues: next };
    });
  },

  resolvePermission: (sessionId, requestId, decision) => {
    const waitId = `wait-${requestId}`;
    set((s) => {
      const prev = s.messagesBySession[sessionId];
      if (!prev) return s;
      const next = prev.filter((b) => b.id !== waitId);
      if (next.length === prev.length) return s;
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next },
        // Centralized focus policy: after the user resolves any in-stream
        // permission/plan prompt, focus returns to the composer so the next
        // keystroke types into the chat. InputBar's effect guards against
        // stealing focus from other text-entry surfaces (rename input,
        // dialog field, IME composition).
        focusInputNonce: s.focusInputNonce + 1
      };
    });
    void window.agentory?.agentResolvePermission(sessionId, requestId, decision);
  },

  bumpComposerFocus: () => {
    set((s) => ({ focusInputNonce: s.focusInputNonce + 1 }));
  },

  loadModels: async () => {
    const api = window.agentory;
    if (!api?.models?.list) {
      set({ modelsLoaded: true });
      return;
    }
    try {
      const list = await api.models.list();
      set({ models: list, modelsLoaded: true });
    } catch {
      set({ modelsLoaded: true });
    }
  },

  loadConnection: async () => {
    const api = window.agentory;
    if (!api?.connection?.read) return;
    try {
      const info = await api.connection.read();
      set({ connection: info });
    } catch {
      /* IPC failed — leave connection as null */
    }
  },

  checkCli: async () => {
    const api = window.agentory;
    if (!api?.cli) {
      // No IPC (e.g. unit test renderer without preload). Mark found to keep
      // the rest of the app usable.
      set({ cliStatus: { state: 'found', binaryPath: '<no-ipc>', version: null } });
      return;
    }
    set({ cliStatus: { state: 'checking' } });
    try {
      const res = await api.cli.retryDetect();
      if (res.found) {
        if (isVersionBelow(res.version, CLI_MIN_VERSION_SOFT)) {
          // Non-blocking: log and keep going.
          console.warn(
            `[cli] Claude CLI ${res.version} is older than the recommended ${CLI_MIN_VERSION_SOFT}. Some features may misbehave.`
          );
        }
        set({
          cliStatus: {
            state: 'found',
            binaryPath: res.path,
            version: res.version,
          },
        });
      } else {
        set({
          cliStatus: {
            state: 'missing',
            searchedPaths: res.searchedPaths,
            dialogOpen: true,
          },
        });
      }
    } catch (err) {
      set({
        cliStatus: {
          state: 'missing',
          searchedPaths: [err instanceof Error ? err.message : String(err)],
          dialogOpen: true,
        },
      });
    }
  },

  setCliMissing: (searchedPaths) => {
    set({ cliStatus: { state: 'missing', searchedPaths, dialogOpen: true } });
  },

  openCliDialog: () => {
    set((s) => {
      if (s.cliStatus.state !== 'missing') return s;
      return { cliStatus: { ...s.cliStatus, dialogOpen: true } };
    });
  },

  closeCliDialog: () => {
    set((s) => {
      if (s.cliStatus.state !== 'missing') return s;
      return { cliStatus: { ...s.cliStatus, dialogOpen: false } };
    });
  },
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
      permission: migratePermission(persisted.permission),
      sidebarCollapsed: persisted.sidebarCollapsed ?? false,
      sidebarWidth: resolvePersistedSidebarWidth(persisted),
      theme: persisted.theme ?? 'system',
      fontSize: persisted.fontSize ?? 'md',
      fontSizePx: persisted.fontSizePx !== undefined
        ? sanitizeFontSizePx(persisted.fontSizePx)
        : legacyFontSizeToPx(persisted.fontSize ?? 'md'),
      density: sanitizeDensity(persisted.density),
      recentProjects: persisted.recentProjects ?? [],
      tutorialSeen: persisted.tutorialSeen ?? false,
      notificationSettings: {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        ...(persisted.notificationSettings ?? {})
      }
    });
  }
  hydrated = true;
  // Kick off a load for the restored active session so the right pane paints
  // history immediately on boot, not on the next click.
  const active = useStore.getState().activeId;
  if (active) void useStore.getState().loadMessages(active);

  // One-shot best-effort migration: probe every persisted session's `cwd`
  // and tag rows whose directory has vanished between runs. We only
  // SET the flag — we never CLEAR an unset one — and the work is fully
  // async so a slow/missing IPC never blocks hydration. The Sidebar dims
  // tagged rows; `agent:start` would also catch this on the spawn path,
  // but tagging up front means the user sees the bad state immediately
  // instead of after their first send. Once the user repicks via the
  // StatusBar cwd chip, `changeCwd` clears the flag.
  void (async () => {
    const sessions = useStore.getState().sessions;
    const uniquePaths = Array.from(new Set(sessions.map((s) => s.cwd).filter(Boolean)));
    if (uniquePaths.length === 0) return;
    const api = window.agentory;
    if (!api?.pathsExist) return;
    let existence: Record<string, boolean>;
    try {
      existence = await api.pathsExist(uniquePaths);
    } catch {
      return;
    }
    const missing = new Set(
      uniquePaths.filter((p) => existence[p] === false)
    );
    if (missing.size === 0) return;
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        missing.has(x.cwd) ? { ...x, cwdMissing: true } : x
      ),
    }));
  })();

  // Seed history-derived defaults from CLI transcripts. Fresh Electron
  // userData starts with empty `recentProjects` and no `model`; without this
  // the new-session picker falls back to `~` and the first endpoint's first
  // model regardless of what the user actually uses in the CLI.
  try {
    const api = window.agentory;
    if (api?.recentCwds && api?.topModel) {
      const [recentCwds, topModel] = await Promise.all([
        api.recentCwds(),
        api.topModel(),
      ]);
      useStore.setState({
        historyRecentCwds: Array.isArray(recentCwds) ? recentCwds : [],
        historyTopModel: typeof topModel === 'string' ? topModel : null,
      });
    }
  } catch {
    /* IPC unavailable — boot continues with empty defaults */
  }

  // Load connection info + discovered models from settings.json. Both come
  // from main; failures leave the empty defaults in place so the UI can still
  // render with placeholder copy.
  await Promise.all([
    useStore.getState().loadConnection(),
    useStore.getState().loadModels(),
  ]);

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
      sidebarWidth: s.sidebarWidth,
      theme: s.theme,
      fontSize: s.fontSize,
      fontSizePx: s.fontSizePx,
      density: s.density,
      recentProjects: s.recentProjects,
      tutorialSeen: s.tutorialSeen,
      notificationSettings: s.notificationSettings
    };
    schedulePersist(snapshot);
  });
}
