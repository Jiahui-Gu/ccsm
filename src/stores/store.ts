import { create } from 'zustand';
import type { Group, Session } from '../types';
import { loadPersisted, schedulePersist, PERSISTED_KEYS, type PersistedState, type PersistedKey } from './persist';
import { hydrateDrafts, deleteDrafts, snapshotDraft, restoreDraft } from './drafts';
import { i18next } from '../i18n';
import type { ConnectionInfo } from '../shared/ipc-types';

// Resolve the localized default-group name with a hard-coded English fallback
// so non-renderer call paths (tests, eager hydration before initI18n runs)
// still get a real string instead of the raw key. Keeping the fallback in
// sync with `sidebar.defaultGroupName` in `src/i18n/locales/en.ts`.
function defaultGroupName(): string {
  const key = 'sidebar.defaultGroupName';
  try {
    const v = i18next.t(key);
    if (typeof v === 'string' && v && v !== key) return v;
  } catch {
    // i18next not initialized — fall through to the hard-coded English.
  }
  return 'Sessions';
}

export type ModelId = string;
// Values match the CLI's `--permission-mode` flag 1:1 so we can pass the enum
// value straight through to claude.exe without a translation table. `auto` is
// a research-preview classifier mode gated on Sonnet 4.6+ / account flag; we
// surface it in the picker and fall back to 'default' (with a toast) if the
// SDK rejects it for the current account/model. `dontAsk` (legacy alias for
// `default`) stays unsurfaced — it's redundant.
//
// The type is still exported for `runningPlaceholder.ts` (which renders mode
// labels) even though the global `permission` store field was removed in
// PR-D — per-session permission mode lives on the `Session` row directly,
// not in the top-level store slot.
export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions' | 'auto';
export type Theme = 'system' | 'light' | 'dark';
/**
 * Legacy categorical font size (`sm`/`md`/`lg`) — kept for persistence back-
 * compat. New code should read `fontSizePx` instead. `migrateFontSize()`
 * maps old values to pixels during hydration.
 */
export type FontSize = 'sm' | 'md' | 'lg';
/** Root font-size in px. One of 12/13/14/15/16. */
export type FontSizePx = 12 | 13 | 14 | 15 | 16;

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

export interface DiscoveredModel {
  id: string;
  source: ModelSource;
}

// Re-export the canonical IPC shape so call sites inside the store layer
// can keep importing `ConnectionInfo` from here. The definition itself lives
// in `src/shared/ipc-types.ts` (single source of truth).
export type { ConnectionInfo };

// Soft minimum was previously surfaced to the user via the now-deleted
// first-run wizard. CCSM ships a fixed binary version inside the installer
// (PR-B), so the renderer no longer needs to know about CLI version floors.
//
// `parseSemver` / `isVersionBelow` were only consumed by the wizard and are
// removed alongside it; the SDK enforces its own version compatibility.

type State = {
  sessions: Session[];
  groups: Group[];
  /**
   * Resolved `os.homedir()` from the main process. Seeded once at boot via
   * `window.ccsm.userHome()`; empty string until the IPC resolves. Used as
   * the new-session default cwd — replaces the old CLI-history-derived
   * default per spec: "default cwd is always home, no fallback chains".
   */
  userHome: string;
  /**
   * Default model from `~/.claude/settings.json` (the CLI's own `--model`
   * default). Seeds the new-session model picker so ccsm picks the same
   * model the user already configured for the CLI. Null until the boot
   * read resolves or if no `model` field is set — in which case
   * createSession leaves `model` empty and the SDK applies its own default.
   */
  claudeSettingsDefaultModel: string | null;
  activeId: string;
  focusedGroupId: string | null;
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
  tutorialSeen: boolean;
  models: DiscoveredModel[];
  modelsLoaded: boolean;
  connection: ConnectionInfo | null;
  /**
   * True once `hydrateStore()` has finished applying the persisted snapshot
   * to the store. Set after the awaited persisted-state load completes —
   * BEFORE `loadConnection()` / `loadModels()` (which are now fire-and-forget
   * post-render). Components that need to know "are we still showing
   * uninitialised defaults?" subscribe to this; e.g. the empty-sessions
   * branch of App.tsx renders skeleton state while false to avoid flashing
   * a "no sessions yet" landing for users who actually have sessions on
   * disk. See perf/startup-render-gate — first paint must not block on
   * hydration, so the renderer mounts immediately and components react to
   * this flag flipping true a tick later.
   */
  hydrated: boolean;
  /**
   * Set when `agent:start` returns errorCode === 'CLAUDE_NOT_FOUND'. CCSM
   * bundles the Claude binary in the installer (PR-B) so this should never
   * fire on a healthy install — when it does, the installer payload is
   * corrupt or partially uninstalled and the user must reinstall. Surfaced
   * by `<InstallerCorruptBanner />` as a non-dismissible top banner.
   */
  installerCorrupt: boolean;
  /**
   * Id of the currently-open popover/menu, or null when nothing is open. A
   * single global slot enforces mutual exclusion: opening any popover sets
   * the id (implicitly closing whatever was previously open), closing sets
   * it back to null. Each popover binds its open state to
   * `useStore(s => s.openPopoverId === '<my-id>')`.
   *
   * NOT persisted — popover open state must not survive reload (would land
   * the user on a randomly-open menu after restart).
   */
  openPopoverId: string | null;
  /**
   * Most-recent cwd from the ccsm-owned `userCwds` LRU (head of the list),
   * cached in renderer state so `createSession` can read it synchronously
   * to default a new session's cwd. Seeded at boot from
   * `window.ccsm.userCwds.get()` and refreshed every time `userCwds.push`
   * resolves. `null` when the LRU is empty (fresh install / user has never
   * picked) — `createSession` falls back to `userHome` in that case.
   *
   * NOT persisted — derived from main-process state on every boot. Out of
   * scope: cwd-missing degradation. If the head path no longer exists on
   * disk we still hand it to the new session; the existing
   * `cwd-missing` flag on Session continues to flag it after creation.
   */
  lastUsedCwd: string | null;
};

export interface CreateSessionOptions {
  cwd?: string | null;
  name?: string;
  /** Force the new session into this group, overriding the
   *  focused/active-group fallback chain. Ignored if the id doesn't
   *  resolve to a normal (non-special) group. */
  groupId?: string;
}

/** Snapshot returned by `deleteSession` so callers can restore the row via
 *  `restoreSession` (undo toast). Captures everything needed to put the
 *  session back exactly where it was — DOM index inside its group and any
 *  draft text. */
export interface SessionSnapshot {
  session: Session;
  /** Index of the session inside `sessions[]` BEFORE deletion. We re-insert
   *  at this index so the visual order in the sidebar is preserved. */
  index: number;
  draft: string;
  prevActiveId: string;
}

/** Snapshot returned by `deleteGroup` for undo. Carries the group plus every
 *  session that cascaded with it (each as a `SessionSnapshot`) so a single
 *  `restoreGroup` call rebuilds the full subtree in original order. */
export interface GroupSnapshot {
  group: Group;
  groupIndex: number;
  sessions: SessionSnapshot[];
  prevActiveId: string;
  prevFocusedGroupId: string | null;
}

type Actions = {
  selectSession: (id: string) => void;
  focusGroup: (id: string | null) => void;
  createSession: (cwd: string | null | CreateSessionOptions) => void;
  importSession: (opts: { name: string; cwd: string; groupId: string; resumeSessionId: string; projectDir?: string }) => string;
  renameSession: (id: string, name: string) => void;
  /** Internal: apply an externally-sourced title (from the JSONL
   *  tail-watcher's `session:title` IPC). Skips if the row is missing or
   *  the name is already current. Underscore prefix marks this as not
   *  user-facing — callers are limited to the IPC subscriber wired in
   *  src/App.tsx. SDK customTitle precedence guarantees user renames win
   *  over SDK auto-summaries, so no userRenamed flag is needed here. */
  _applyExternalTitle: (sid: string, title: string) => void;
  deleteSession: (id: string) => SessionSnapshot | null;
  /** Re-insert a session previously removed by `deleteSession`. Restores the
   *  row at its original index, plus messages, draft, and runtime flags. */
  restoreSession: (snapshot: SessionSnapshot) => void;
  moveSession: (sessionId: string, targetGroupId: string, beforeSessionId: string | null) => void;
  changeCwd: (cwd: string) => void;
  /** Update a specific session's model. Pushes the change to the live
   *  agent if the session has been started. */
  setSessionModel: (sessionId: string, model: ModelId) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  setFontSizePx: (px: FontSizePx) => void;
  setSidebarWidth: (px: number) => void;
  resetSidebarWidth: () => void;
  markTutorialSeen: () => void;

  createGroup: (name?: string) => string;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => GroupSnapshot | null;
  /** Re-insert a group + all its sessions captured by `deleteGroup`. */
  restoreGroup: (snapshot: GroupSnapshot) => void;
  archiveGroup: (id: string) => void;
  unarchiveGroup: (id: string) => void;
  setGroupCollapsed: (id: string, collapsed: boolean) => void;

  loadModels: () => Promise<void>;
  loadConnection: () => Promise<void>;

  /** Flip the `installerCorrupt` banner on (true) or off (false). Called
   *  from `startSession` on `CLAUDE_NOT_FOUND`. */
  setInstallerCorrupt: (corrupt: boolean) => void;

  /**
   * Open the popover/menu identified by `id`. Sets `openPopoverId` to `id`,
   * which implicitly closes any other popover currently bound to the same
   * slot. Safe to call when already open (no-op).
   */
  openPopover: (id: string) => void;
  /**
   * Close the popover/menu identified by `id`, but ONLY if it's currently the
   * open one. Idempotent: a stale close from a popover that was already
   * superseded by another opener won't clobber the new owner's slot.
   */
  closePopover: (id: string) => void;
};

function nextId(prefix: string): string {
  // Prefer crypto.randomUUID (available in Electron renderer + Node ≥ 14.17)
  // — collision-resistant across rapid in-tick creation, unlike the prior
  // `Date.now() + Math.random().slice(2,6)` combo. Keep the `prefix-` shape
  // so existing logs / DOM ids stay parseable.
  const g: { crypto?: { randomUUID?: () => string } } =
    (typeof globalThis !== 'undefined' ? (globalThis as unknown as { crypto?: { randomUUID?: () => string } }) : {}) ?? {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return `${prefix}-${g.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Mint a session id using the same raw UUID format the Claude Code CLI uses
 * for its `~/.claude/projects/<project>/<sid>.jsonl` filenames. ccsm passes
 * this id to the SDK's `sessionId` option at spawn time, so the JSONL
 * transcript file name is identical to the in-app session id — no two
 * separate ids to reconcile, no mapping table.
 *
 * Why not `nextId('s')`: the legacy `s-<uuid>` form isn't a valid UUID
 * accepted by the SDK's `sessionId` option, and it forces every external
 * tooling integration (jsonl reader, share/export, dogfood `tail`) to
 * strip the prefix or maintain a side-table.
 *
 * Existing persisted sessions keep their `s-<uuid>` ids (per the
 * "no schema migration for old users" decision); they continue to work
 * because the CLI accepts any string as a session id when a fresh spawn
 * is allocated by the SDK rather than passed in. Newly-created sessions
 * after this change use raw UUIDs end-to-end.
 */
function newSessionId(): string {
  const g: { crypto?: { randomUUID?: () => string } } =
    (typeof globalThis !== 'undefined' ? (globalThis as unknown as { crypto?: { randomUUID?: () => string } }) : {}) ?? {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  // Fallback: synthesize a UUID-shaped string. The SDK validates the field
  // is a UUID, so we follow the v4 layout (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
  // even when crypto is unavailable (Node < 14.17 / locked-down sandbox).
  // This branch is effectively dead in production but keeps tests under jsdom
  // happy when randomUUID is shimmed away.
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const y = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${y}${hex(3)}-${hex(12)}`;
}

// `migratePermission` and `migrateNotificationSettings` were removed in PR-D
// alongside the `permission` and `notificationSettings` store fields. Older
// persisted snapshots may still carry those keys; they're silently ignored
// when `hydrateStore` builds its `setState` payload.

function firstUsableGroupId(groups: Group[]): string | null {
  const g = groups.find((x) => x.kind === 'normal');
  return g ? g.id : null;
}

/**
 * Resolve "where should the next session go?" — return either an existing
 * usable (`kind === 'normal'`) group, or synthesize a fresh one with the
 * current language's default name. When a group is synthesized, callers MUST
 * use the returned `groups` array (it includes the new row) so the GroupRow
 * and SessionRow render in the same tick. The synthesized group carries
 * `nameKey` so a later language switch re-localizes the label instead of
 * leaving it frozen to whatever locale was active at creation time.
 *
 * `preferredId` is honoured iff it points at an existing normal group.
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
    kind: 'normal'
  };
  return { groups: [synth, ...groups], groupId: synth.id };
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

const defaultGroups: Group[] = [
  // The bootstrap "Sessions" group also carries `nameKey` so a language
  // switch re-localizes its label (the user never explicitly named this
  // row — it's a default surface, not user input).
  { id: 'g-default', name: 'Sessions', nameKey: 'sidebar.defaultGroupName', collapsed: false, kind: 'normal' }
];

export const useStore = create<State & Actions>((set, get) => ({
  sessions: [],
  groups: defaultGroups,
  userHome: '',
  claudeSettingsDefaultModel: null,
  activeId: '',
  focusedGroupId: null,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  theme: 'system',
  fontSize: 'md',
  fontSizePx: 14,
  tutorialSeen: false,
  models: [],
  modelsLoaded: false,
  connection: null,
  hydrated: false,
  installerCorrupt: false,
  openPopoverId: null,
  lastUsedCwd: null,

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
      lastUsedCwd,
    } = get();
    const isUsable = (gid: string | null | undefined) => {
      if (!gid) return false;
      const g = groups.find((x) => x.id === gid);
      return !!g && g.kind === 'normal';
    };
    const activeGroupId = sessions.find((s) => s.id === activeId)?.groupId;
    // Resolve preference order without touching synthesis: caller-provided →
    // focused → active session's group → ensureUsableGroup will pick first
    // normal group or synthesize one (with nameKey).
    const preferred = isUsable(opts.groupId)
      ? opts.groupId!
      : isUsable(focusedGroupId)
      ? focusedGroupId!
      : isUsable(activeGroupId)
      ? activeGroupId!
      : null;
    const ensured = ensureUsableGroup(groups, preferred);
    const targetGroupId = ensured.groupId;
    const baseGroups = ensured.groups;
    const id = newSessionId();
    // Default cwd is the most recently used cwd from the ccsm-owned
    // `userCwds` LRU (the head of the list), falling back to the user's
    // home directory when the LRU is empty (fresh install / user has
    // never explicitly picked a cwd). Per task #551 ("default new-session
    // cwd to last-used"): repeat use of the same project should not
    // require re-picking the cwd every time. Caller-provided `opts.cwd`
    // always wins. The LRU itself is fed from three signals:
    //   - explicit picks via the StatusBar cwd popover (`setSessionCwd`)
    //   - new-session creation against an explicit cwd (below)
    //   - importing an existing transcript (`importSession` below)
    // Out of scope: cwd-missing degradation. If the LRU head no longer
    // exists on disk we still hand it to the new session; the existing
    // `cwd-missing` post-create flag continues to surface that case.
    const defaultCwd = lastUsedCwd ?? userHome ?? '';
    // Default model reads `~/.claude/settings.json` `model` field — the SAME
    // value the CLI itself reads for `--model` defaulting (PR #386 made the
    // read CLAUDE_CONFIG_DIR-aware). When unset, leave `model` empty so the
    // SDK applies its own default at session start. Per spec we explicitly
    // do NOT consult the persisted global `model`, the connection profile,
    // or the first discovered model — those silently shadow the CLI default
    // and produced unselectable picker values in the wild.
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
    // If the target group is currently collapsed, expand it in the same
    // atomic update so the new row is visible the moment activeId flips.
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
    // If the user explicitly created the session against a non-default cwd
    // (cwd override differs from home), record it in the ccsm-owned LRU so
    // it shows in the popover's recent column on subsequent opens. Fire-and-
    // forget — the IPC is best-effort and the renderer doesn't need the
    // post-update list (the popover refetches on each open).
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
      // Optimistic local update so an immediately-following createSession
      // (before the IPC resolves) sees the new head. Skipped when the
      // value is already the head — avoids a redundant set + re-render.
      if (finalCwd !== lastUsedCwd) set({ lastUsedCwd: finalCwd });
    }
  },

  renameSession: (id, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x))
    }));
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

  importSession: ({ name, cwd, groupId, resumeSessionId, projectDir: _projectDir }) => {
    const { sessions, groups, models, connection } = get();
    // Re-importing the same transcript: just re-select the existing row.
    // The JSONL UUID uniquely identifies the conversation, and our session
    // record already holds it as `id` (see below), so a duplicate import
    // becomes a no-op that focuses the session the user already has.
    const existing = sessions.find((s) => s.id === resumeSessionId);
    if (existing) {
      set({ activeId: existing.id, focusedGroupId: null });
      return existing.id;
    }
    // Imported sessions adopt the JSONL filename UUID as the ccsm runner id
    // (same invariant fresh sessions follow: ccsm id == CLI session UUID ==
    // JSONL filename UUID). This keeps the SDK's reported session_id, the
    // on-disk transcript path, and our in-app id in lockstep — without it
    // `electron/agent-sdk/sessions.ts` fires a `session_id_mismatch`
    // diagnostic on the first SDK init frame after resume.
    const id = resumeSessionId;
    // Resolve initial model from the discovery sources only — the global
    // `model` store slot was removed in PR-D (no readers). Order matches
    // createSession's intent: connection profile first (the CLI's own
    // configured default), then first discovered model as a last resort.
    let initialModel = connection?.model ?? '';
    if (!initialModel) initialModel = models[0]?.id ?? '';
    // Safety net: if the caller passed a groupId that doesn't exist in the
    // store (e.g. stale id from a stripped persisted blob), ensureUsableGroup
    // either falls back to the first normal group or synthesizes a fresh
    // default-named one rather than orphaning the imported row.
    const ensured = ensureUsableGroup(groups, groupId);
    const imported: Session = {
      id,
      name,
      state: 'idle',
      cwd,
      model: initialModel,
      groupId: ensured.groupId,
      agentType: 'claude-code',
      resumeSessionId
    };
    set({
      sessions: [imported, ...sessions],
      activeId: id,
      focusedGroupId: null,
      groups: ensured.groups
    });
    // Importing an existing transcript is a strong "user is working in
    // this cwd" signal — feed it into the same `userCwds` LRU that fresh
    // sessions populate so the next `+` click defaults to it.
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
      prevActiveId: prev.activeId
    };
    set((s) => {
      const remaining = s.sessions.filter((x) => x.id !== id);
      // Same-group sibling fallback (J5): when the active row is being
      // deleted, prefer the next session that lives in the same group as
      // the deleted one (next index, then prev index). Only fall back to
      // `remaining[0]` when the source group becomes empty — this keeps
      // the user's contextual focus inside the group they were working in.
      let nextActive = s.activeId;
      if (s.activeId === id) {
        const sourceGroupId = target.groupId;
        const sameGroup = remaining.filter((x) => x.groupId === sourceGroupId);
        if (sameGroup.length > 0) {
          // Find the original sibling closest to `idx` in the source group.
          // Iterate over remaining preserving order and pick the first sibling
          // whose original index was >= idx (= "next sibling"); fall back to
          // the last sibling whose original index was < idx (= "prev sibling").
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
    // Also drop any persisted draft for this session.
    deleteDrafts([id]);
    // Kill the per-session pty so the underlying claude CLI doesn't
    // outlive its ccsm session row. Without this, deleting from the sidebar
    // leaves an orphan claude child holding the JSONL transcript open.
    // Fire-and-forget — main reaps on quit anyway and we don't want to
    // gate the optimistic UI / undo flow on an IPC roundtrip.
    try {
      void window.ccsmPty?.kill(id).catch(() => {});
    } catch {
      /* renderer started without preload (tests) — no-op */
    }
    return snapshot;
  },

  restoreSession: (snapshot) => {
    set((s) => {
      // Skip if the id is somehow already back (double-undo guard).
      if (s.sessions.some((x) => x.id === snapshot.session.id)) return s;
      const insertAt = Math.min(Math.max(snapshot.index, 0), s.sessions.length);
      const sessions = [
        ...s.sessions.slice(0, insertAt),
        snapshot.session,
        ...s.sessions.slice(insertAt)
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
      // Reject drops onto archived (or any non-normal) groups: archive is a
      // read-only bucket — stuffing a live session in there would surface as
      // an "invisible" row (sidebar collapses archived by default) and the
      // user would lose track of it.
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
    // Cwd picks via the StatusBar popover or Browse... button are the
    // canonical "user explicitly chose this cwd" signal — feed them into
    // the ccsm-owned LRU so they surface in the popover's recent column on
    // future opens. Skip the home entry: it's the always-default and lives
    // in the list as the implicit fallback.
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
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, model } : x))
    }));
  },
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setTheme: (theme) => set({ theme }),
  setFontSize: (fontSize) => set({ fontSize, fontSizePx: legacyFontSizeToPx(fontSize) }),
  setFontSizePx: (fontSizePx) => set({ fontSizePx, fontSize: pxToLegacyFontSize(fontSizePx) }),
  setSidebarWidth: (px) => set({ sidebarWidth: sanitizeSidebarWidth(px) }),
  resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT }),
  markTutorialSeen: () => set({ tutorialSeen: true }),

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
    const prev = get();
    const groupIndex = prev.groups.findIndex((g) => g.id === id);
    if (groupIndex === -1) return null;
    const group = prev.groups[groupIndex];
    // Snapshot every member session as a SessionSnapshot so restoreGroup
    // can lean on the same per-session restore plumbing.
    const memberSnapshots: SessionSnapshot[] = prev.sessions
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.groupId === id)
      .map(({ s, i }) => ({
        session: s,
        index: i,
        draft: snapshotDraft(s.id),
        prevActiveId: prev.activeId
      }));
    const snapshot: GroupSnapshot = {
      group,
      groupIndex,
      sessions: memberSnapshots,
      prevActiveId: prev.activeId,
      prevFocusedGroupId: prev.focusedGroupId
    };
    set((s) => {
      const remainingSessions = s.sessions.filter((x) => x.groupId !== id);
      const droppedIds = s.sessions.filter((x) => x.groupId === id).map((x) => x.id);
      const nextActive = remainingSessions.some((x) => x.id === s.activeId)
        ? s.activeId
        : remainingSessions[0]?.id ?? '';
      // Drop drafts for every session that vanished with the group.
      if (droppedIds.length > 0) deleteDrafts(droppedIds);
      return {
        groups: s.groups.filter((g) => g.id !== id),
        sessions: remainingSessions,
        activeId: nextActive,
        focusedGroupId: s.focusedGroupId === id ? null : s.focusedGroupId,
      };
    });
    return snapshot;
  },

  restoreGroup: (snapshot) => {
    set((s) => {
      // Skip if the group already exists (double-undo guard).
      if (s.groups.some((g) => g.id === snapshot.group.id)) return s;
      const insertAt = Math.min(Math.max(snapshot.groupIndex, 0), s.groups.length);
      const groups = [
        ...s.groups.slice(0, insertAt),
        snapshot.group,
        ...s.groups.slice(insertAt)
      ];
      // Re-insert sessions one at a time, in their original index order, so
      // each placement uses the live `sessions` array (later snapshots may
      // have indices that depend on earlier ones being back).
      let sessions = s.sessions.slice();
      const ordered = snapshot.sessions
        .slice()
        .sort((a, b) => a.index - b.index);
      for (const snap of ordered) {
        if (sessions.some((x) => x.id === snap.session.id)) continue;
        const insertSesAt = Math.min(Math.max(snap.index, 0), sessions.length);
        sessions = [
          ...sessions.slice(0, insertSesAt),
          snap.session,
          ...sessions.slice(insertSesAt)
        ];
      }
      return {
        groups,
        sessions,
        activeId: snapshot.prevActiveId || s.activeId,
        focusedGroupId: snapshot.prevFocusedGroupId,
      };
    });
    for (const snap of snapshot.sessions) {
      restoreDraft(snap.session.id, snap.draft);
    }
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


  openPopover: (id) => {
    set((s) => (s.openPopoverId === id ? s : { openPopoverId: id }));
  },

  closePopover: (id) => {
    set((s) => (s.openPopoverId === id ? { openPopoverId: null } : s));
  },

  loadModels: async () => {
    const api = window.ccsm;
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
    const api = window.ccsm;
    if (!api?.connection?.read) return;
    try {
      const info = await api.connection.read();
      set({ connection: info });
    } catch {
      /* IPC failed — leave connection as null */
    }
  },

  setInstallerCorrupt: (corrupt) => {
    set({ installerCorrupt: corrupt });
  },
}));

let hydrated = false;

/**
 * Boot timing trace exposed on `window.__ccsmHydrationTrace`. Populated by
 * `index.tsx` (renderedAt) and `hydrateStore()` (hydrateStartedAt /
 * hydrateDoneAt). Used by the harness-ui case
 * `startup-paints-before-hydrate` to assert renderedAt < hydrateDoneAt —
 * i.e. that React mounted before the awaited persisted-state load
 * resolved. Same E2E-debug-affordance trade-off as `__ccsmStore`.
 */
export interface HydrationTrace {
  renderedAt?: number;
  hydrateStartedAt?: number;
  hydrateDoneAt?: number;
}

// Compile-time guard: every key in PERSISTED_KEYS must exist on State (so the
// subscriber's `s[k]` read is well-typed) AND on PersistedState (so the
// snapshot we hand to schedulePersist is structurally valid). If a key is
// added to PERSISTED_KEYS that doesn't exist on either, this assertion fails
// at typecheck — keeping the source-of-truth array honest.
type _AssertPersistedKeysOnState = PersistedKey extends keyof State ? true : never;
type _AssertPersistedKeysOnPersisted = PersistedKey extends keyof PersistedState ? true : never;
const _persistedKeysOnState: _AssertPersistedKeysOnState = true;
const _persistedKeysOnPersisted: _AssertPersistedKeysOnPersisted = true;
void _persistedKeysOnState;
void _persistedKeysOnPersisted;

export async function hydrateStore(): Promise<void> {
  if (hydrated) return;
  // E2E + perf trace. Pinned by harness-ui case `startup-paints-before-hydrate`
  // to verify render() runs before hydrate resolves. Same security/scope
  // trade-off as `__ccsmStore`.
  const trace =
    (typeof window !== 'undefined'
      ? ((window as unknown as { __ccsmHydrationTrace?: HydrationTrace }).__ccsmHydrationTrace ??=
          {} as HydrationTrace)
      : ({} as HydrationTrace));
  trace.hydrateStartedAt = Date.now();
  // Drafts live alongside the main snapshot but in their own key — load both
  // before render so the InputBar's initial value is the persisted draft, not
  // an empty string that flashes for one tick.
  await hydrateDrafts();
  const persisted = await loadPersisted();
  if (persisted) {
    const stillActive = persisted.sessions.some((s) => s.id === persisted.activeId);
    // Migration: older snapshots may carry `model`, `permission`, and
    // `notificationSettings` keys (PR-D removed them as orphan persisted
    // state with no subscribers). We simply don't read them — `loadPersisted`
    // returns the parsed JSON unchanged, and unrecognised top-level keys
    // bypass the setState below without errors.
    useStore.setState({
      sessions: persisted.sessions,
      groups: persisted.groups,
      activeId: stillActive ? persisted.activeId : persisted.sessions[0]?.id ?? '',
      sidebarCollapsed: persisted.sidebarCollapsed ?? false,
      sidebarWidth: resolvePersistedSidebarWidth(persisted),
      theme: persisted.theme ?? 'system',
      fontSize: persisted.fontSize ?? 'md',
      fontSizePx: persisted.fontSizePx !== undefined
        ? sanitizeFontSizePx(persisted.fontSizePx)
        : legacyFontSizeToPx(persisted.fontSize ?? 'md'),
      tutorialSeen: persisted.tutorialSeen ?? false,
    });
  }
  // Flip `hydrated` BEFORE kicking off the deferred IPCs below — components
  // that gate their first paint on this can stop showing skeleton state the
  // moment the persisted snapshot lands, even though connection/models may
  // still be in flight for another 100-500ms.
  useStore.setState({ hydrated: true });
  hydrated = true;
  trace.hydrateDoneAt = Date.now();

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
    const api = window.ccsm;
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

  // Seed boot defaults from main: `userHome` is the always-true default cwd
  // for new sessions, and `claudeSettingsDefaultModel` is the CLI's own
  // `--model` default (read from `~/.claude/settings.json`). Both are
  // best-effort — if the IPC fails, the renderer keeps its empty defaults
  // and the SDK falls back to its built-ins. Fire-and-forget so a slow IPC
  // (or a binary shell-out from defaultModel) doesn't gate first paint.
  void (async () => {
    try {
      const api = window.ccsm;
      if (api?.userHome && api?.defaultModel) {
        const [userHome, defaultModel] = await Promise.all([
          api.userHome(),
          api.defaultModel(),
        ]);
        useStore.setState({
          userHome: typeof userHome === 'string' ? userHome : '',
          claudeSettingsDefaultModel: typeof defaultModel === 'string' ? defaultModel : null,
        });
      }
      // Seed `lastUsedCwd` from the ccsm-owned `userCwds` LRU so the very
      // first `+` click after launch already lands in the user's most
      // recent project. Without this, the first session of every boot
      // would silently fall back to home and re-train the picker. Skip
      // when the only entry is `userHome` — that's the empty-LRU sentinel
      // (`getUserCwds()` always appends home), which means "no real
      // pick", so we leave `lastUsedCwd` null and let createSession use
      // userHome via the explicit fallback.
      if (api?.userCwds?.get) {
        const list = await api.userCwds.get().catch(() => [] as string[]);
        const head = Array.isArray(list) && list.length > 0 ? list[0] : null;
        const home = useStore.getState().userHome;
        if (head && head !== home) {
          useStore.setState({ lastUsedCwd: head });
        }
      }
    } catch {
      /* IPC unavailable — boot continues with empty defaults */
    }
  })();

  // Connection info + discovered models from settings.json. Demoted to
  // fire-and-forget post-hydrate (perf/startup-render-gate): `loadModels`
  // shells out to the claude binary and can take 100-500ms; awaiting it
  // here would gate first paint by that much. Consumers
  // (SettingsDialog, StatusBar) already render an empty/loading state
  // until `models` populates and re-fire these themselves on mount.
  void useStore.getState().loadConnection();
  void useStore.getState().loadModels();

  // After (potential) hydration, subscribe to write-through.
  // Perf: the subscriber fires on EVERY store mutation (including hot paths
  // like appendBlocks per stream chunk). We early-bail when none of the
  // top-level fields that actually get persisted have changed, so we never
  // build the snapshot object or hit `schedulePersist`'s debounce timer for
  // mutations that wouldn't change disk state anyway. Fields are checked by
  // reference — every persisted field is either a primitive or an immutable
  // array we replace on update, so reference equality is correct.
  //
  // Both the comparator and the snapshot iterate `PERSISTED_KEYS` (defined
  // in persist.ts) so adding a new persisted field only requires editing
  // that one array.
  let prevSnap: State | null = null;
  useStore.subscribe((s) => {
    if (prevSnap !== null) {
      let changed = false;
      for (const k of PERSISTED_KEYS) {
        if (prevSnap[k] !== s[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    prevSnap = s;
    const snapshot = { version: 1 as const } as PersistedState;
    for (const k of PERSISTED_KEYS) {
      // The PERSISTED_KEYS list is statically derived from State and matches
      // PersistedState 1:1 (modulo `version`, which is a literal stamped
      // above). The cast keeps the per-key assignment narrow without forcing
      // every call site to spell out the union.
      (snapshot as unknown as Record<string, unknown>)[k] = s[k];
    }
    schedulePersist(snapshot);
  });
}
