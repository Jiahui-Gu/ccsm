import { create } from 'zustand';
import type { RecentProject } from '../mock/data';
import type { Group, Session, MessageBlock, ImageAttachment } from '../types';
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
// value straight through to claude.exe without a translation table. `auto` is
// a research-preview classifier mode gated on Sonnet 4.6+ / account flag; we
// surface it in the picker and fall back to 'default' (with a toast) if the
// SDK rejects it for the current account/model. `dontAsk` (legacy alias for
// `default`) stays unsurfaced — it's redundant.
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

// Snapshot of the last completed turn's context-window usage. Updated from
// the latest `result` frame's `usage` (current prompt size, NOT the
// cumulative API tokens that `SessionStats` tracks) and the model-aware
// `contextWindow` reported in `modelUsage[model].contextWindow`. Drives the
// StatusBar context-usage pie chip. Ephemeral — not persisted; the chip just
// stays hidden until the first turn after reload.
export interface SessionContextUsage {
  /** Latest turn's prompt size: input + cache_creation + cache_read tokens.
   *  This is the live "how full is the context window" number. */
  totalTokens: number;
  /** Model-reported context window for that turn (e.g. 200_000 for sonnet/opus).
   *  Null when claude.exe didn't report `modelUsage` (older CLI / error frame). */
  contextWindow: number | null;
  /** Model id from the same `modelUsage` entry, kept for tooltip display. */
  model: string | null;
}

export interface DiscoveredModel {
  id: string;
  source: ModelSource;
}

// Re-export the canonical IPC shape so call sites inside the store layer
// can keep importing `ConnectionInfo` from here. The definition itself lives
// in `src/shared/ipc-types.ts` (single source of truth).
export type { ConnectionInfo };

// OS-level notification preferences. Persisted as a single JSON blob alongside
// the rest of app state.
export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  sound: true
};

/**
 * Transient diagnostic surfaced from the agent subsystem (initialize handshake
 * failed, control_request timed out, etc). Originates in
 * `electron/agent/sessions.ts` → `manager.ts` emits `agent:diagnostic` on the
 * WebContents → `src/agent/lifecycle.ts` pushes into the store slice below.
 * The UI shows the most-recent, not-yet-dismissed entry as a banner above
 * ChatStream.
 */
export interface DiagnosticEntry {
  id: string;
  sessionId: string;
  level: 'warn' | 'error';
  code: string;
  message: string;
  timestamp: number;
  dismissed?: boolean;
}

/**
 * Per-session init-failure flag. Populated by InputBar when `agent:start`
 * returns `!ok` with an error code other than the ones with bespoke UX
 * (CLAUDE_NOT_FOUND → installer-corrupt banner; CWD_MISSING → inline error block + StatusBar
 * hint). Cleared on successful retry or when the user repicks the cwd/model.
 *
 * The UI surfaces this as an actionable banner ("Failed to start Claude — Retry
 * / Reconfigure") so a stuck session isn't left silently spinning on
 * `setRunning(true)` with no explanation.
 */
export interface SessionInitFailure {
  error: string;
  errorCode?: string;
  searchedPaths?: string[];
  timestamp: number;
}

// Soft minimum was previously surfaced to the user via the now-deleted
// first-run wizard. CCSM ships a fixed binary version inside the installer
// (PR-B), so the renderer no longer needs to know about CLI version floors.
//
// `parseSemver` / `isVersionBelow` were only consumed by the wizard and are
// removed alongside it; the SDK enforces its own version compatibility.

type State = {
  sessions: Session[];
  groups: Group[];
  recentProjects: RecentProject[];
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
  model: ModelId;
  permission: PermissionMode;
  /**
   * Global default effort level applied to NEW sessions and to any session
   * without a per-session override in `effortLevelBySession`. Six values:
   *  off | low | medium | high | xhigh | max  (default: 'high').
   * Wire path projects this to SDK `thinking` + `effort` at launch and to
   * concurrent `setMaxThinkingTokens` + `applyFlagSettings({effortLevel})`
   * RPCs mid-session — see `src/agent/effort.ts`.
   */
  globalEffortLevel: EffortLevel;
  /**
   * Per-session effort level. Absent => inherit `globalEffortLevel`.
   * Persisted alongside permission so a relaunch picks up the same chip
   * value the user left each session in.
   */
  effortLevelBySession: Record<string, EffortLevel>;
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
  notificationSettings: NotificationSettings;
  messagesBySession: Record<string, MessageBlock[]>;
  /**
   * Transient load-history error per session. Populated when `loadMessages`
   * IPC throws; cleared on next successful load (or explicit retry). The
   * ChatStream renders an inline ErrorBlock when this is set so a failed
   * history fetch isn't silent.
   */
  loadMessageErrors: Record<string, string>;
  startedSessions: Record<string, true>;
  runningSessions: Record<string, true>;
  statsBySession: Record<string, SessionStats>;
  /** Last-turn context-usage snapshot per session, updated from `result`
   *  frames. Used by StatusBar's context-pie chip. Cleared on session
   *  delete and on `/clear`-style transcript wipes. */
  contextUsageBySession: Record<string, SessionContextUsage>;
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
  // Monotonic counter bumped whenever a user-driven action requests that the
  // InputBar textarea take focus (e.g. clicking a session in the sidebar,
  // matching Claude Desktop's behavior). InputBar `useEffect`s on this and
  // calls `.focus()`. Initial value is 0 so first-render comparisons are
  // trivial — InputBar skips the first observation to avoid stealing focus
  // on app mount. Don't bump from background/system events; only user clicks.
  focusInputNonce: number;
  /**
   * Set when `agent:start` returns errorCode === 'CLAUDE_NOT_FOUND'. CCSM
   * bundles the Claude binary in the installer (PR-B) so this should never
   * fire on a healthy install — when it does, the installer payload is
   * corrupt or partially uninstalled and the user must reinstall. Surfaced
   * by `<InstallerCorruptBanner />` as a non-dismissible top banner.
   */
  installerCorrupt: boolean;
  /** Bumped by `injectComposerText` to ask the InputBar to overwrite its draft
   *  with `composerInjectText`. Same nonce-pull pattern as `focusInputNonce`
   *  (skip-first-observation, ref-tracked) so app mount doesn't clobber a
   *  user's persisted draft. Used by the user-message hover menu's "Edit and
   *  resend" action. */
  composerInjectNonce: number;
  composerInjectText: string;
  /** Per-session "draft was about to be overwritten" stash. The user-message
   *  hover menu's Edit action would otherwise silently replace whatever the
   *  user was typing in the composer. Instead we stash the live draft into
   *  this list (newest first) so the InputBar's ↑/↓ recall surfaces it as
   *  if it were a sent prompt. Not persisted — same rationale as drafts:
   *  this is ephemeral recall sugar, not history of record. */
  stashedDrafts: Record<string, string[]>;
  /** Recent agent diagnostics (newest last). Capped at 20 in-memory; the
   *  renderer only surfaces the latest non-dismissed one. Not persisted —
   *  these are ephemeral run-time signals. */
  diagnostics: DiagnosticEntry[];
  /** Per-session init-failure state. See `SessionInitFailure` for semantics.
   *  Cleared on successful retry via `clearSessionInitFailure`. */
  sessionInitFailures: Record<string, SessionInitFailure>;
  /**
   * Tool names the user has granted a session-scoped "allow always" decision
   * for. A permission request whose `toolName` is in this set auto-resolves
   * Allow without rendering a waiting block.
   *
   * Session-scoped (NOT persisted): resets on app restart. See PR discussion —
   * persisting across restarts risks a rarely-revisited allowlist leaking
   * privileges into future workdays. User explicitly re-confirms after each
   * launch.
   */
  allowAlwaysTools: string[];
  /**
   * Per-session pending diff comments (#303). Keyed by sessionId then by
   * commentId. Each comment ties a free-text note to a specific
   * `(filePath, line)` in a DiffView the user is reviewing. On the next
   * `send()` from InputBar these are serialized as `<diff-feedback file=…
   * line=…>…</diff-feedback>` blocks prepended to the user's prompt body
   * and then cleared. Session-scoped + in-memory only — comments are lost
   * on app reload by design (avoids the "old draft feedback resurfaces
   * later in a new conversation" surprise).
   */
  pendingDiffComments: Record<string, Record<string, PendingDiffComment>>;
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
  // task322: continue-after-interrupt — per-session record of how the most
  // recent turn ended. 'interrupted' triggers the InputBar continue-hint;
  // 'ok' / missing = no hint. Set in `markInterrupted`, cleared in
  // `setRunning(id, true)` when a fresh turn begins. Not persisted — a hint
  // surviving an app reload would feel stale.
  lastTurnEnd: Record<string, 'ok' | 'interrupted'>;
};

/**
 * One pending per-line comment attached to a DiffView (#303). Created when
 * the user opens the inline composer in a diff gutter and saves text. The
 * `file` + `line` pair locate the comment for serialization on send; `id`
 * is opaque (used as the React key + delete handle).
 *
 * `line` is the 1-based index of the changed line WITHIN the diff hunk's
 * combined removed-then-added stream as rendered by DiffView (which is the
 * unit the user sees and points at). It is NOT a source-file line number —
 * the agent gets enough context from the surrounding diff in the same turn
 * to map it back, and trying to compute real source-file line numbers from
 * a non-Myers diff would be brittle for the typical Edit/Write/MultiEdit
 * shape this app renders.
 */
export interface PendingDiffComment {
  id: string;
  file: string;
  line: number;
  text: string;
  createdAt: number;
  // Bumped when an existing (file, line) comment is overwritten by a fresh
  // addDiffComment call. Sort order still keys on createdAt so the prompt
  // serialization stays deterministic across the replace; updatedAt is
  // informational only.
  updatedAt?: number;
}

/**
 * Serialize a session's pending diff comments into the structured prefix
 * we prepend to the next user prompt body. Each comment becomes one
 * `<diff-feedback file="…" line="N">text</diff-feedback>` block on its own
 * line; comments are sorted by (file, line, createdAt) so the prefix is
 * deterministic across renders. Returns '' when there are no comments,
 * which lets callers append unconditionally without a length check.
 */
export function serializeDiffCommentsForPrompt(
  comments: Record<string, PendingDiffComment> | undefined,
): string {
  if (!comments) return '';
  const list = Object.values(comments);
  if (list.length === 0) return '';
  // Stable order: file path asc, then line asc, then createdAt asc. Keeps
  // the serialized output identical across renders so test assertions on
  // exact string output don't flap on Object.values insertion order.
  list.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.createdAt - b.createdAt;
  });
  return list
    .map((c) => {
      // Escape the attribute value so a path with `"` can't break out of
      // the file= attribute.
      const file = c.file.replace(/"/g, '&quot;');
      // Escape XML metacharacters in the body so user-typed text containing
      // `<`, `&`, or even a literal `</diff-feedback>` can't break out of
      // the envelope or confuse the agent's tag parser. Order matters:
      // `&` must be replaced first, otherwise we'd double-escape the `&`
      // introduced by the subsequent `<` → `&lt;` substitution.
      const text = c.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<diff-feedback file="${file}" line="${c.line}">${text}</diff-feedback>`;
    })
    .join('\n');
}

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
 *  session back exactly where it was — DOM index inside its group, message
 *  history, draft text, and any in-flight runtime flags. */
export interface SessionSnapshot {
  session: Session;
  /** Index of the session inside `sessions[]` BEFORE deletion. We re-insert
   *  at this index so the visual order in the sidebar is preserved. */
  index: number;
  messages: MessageBlock[] | undefined;
  draft: string;
  started: boolean;
  running: boolean;
  interrupted: boolean;
  queue: QueuedMessage[] | undefined;
  stats: SessionStats | undefined;
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
  deleteSession: (id: string) => SessionSnapshot | null;
  /** Re-insert a session previously removed by `deleteSession`. Restores the
   *  row at its original index, plus messages, draft, and runtime flags. */
  restoreSession: (snapshot: SessionSnapshot) => void;
  moveSession: (sessionId: string, targetGroupId: string, beforeSessionId: string | null) => void;
  changeCwd: (cwd: string) => void;
  pushRecentProject: (path: string) => void;
  /** Update the global default model. Does NOT touch any per-session model;
   *  callers that mean "change the active session" should use
   *  `setSessionModel`. Splitting these prevents the StatusBar dropdown
   *  silently rewriting other sessions' pinned model on a global change. */
  setGlobalModel: (model: ModelId) => void;
  /** Update a specific session's model. Pushes the change to the live
   *  agent if the session has been started. Does NOT touch the global
   *  default. */
  setSessionModel: (sessionId: string, model: ModelId) => void;
  setPermission: (mode: PermissionMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  setFontSizePx: (px: FontSizePx) => void;
  setSidebarWidth: (px: number) => void;
  resetSidebarWidth: () => void;
  markTutorialSeen: () => void;
  setNotificationSettings: (patch: Partial<NotificationSettings>) => void;

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

/**
 * Coerce a persisted notification-settings blob into the current
 * `{ enabled, sound }` shape. The pre-simplification shape carried per-event
 * toggles (`permission` / `question` / `turnDone`) plus a global `enabled`
 * and `sound`. Strip any unknown keys, fill missing fields with defaults
 * (true) so a partial blob doesn't silently mute the user.
 */
export function migrateNotificationSettings(
  raw: unknown
): NotificationSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_NOTIFICATION_SETTINGS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    sound: typeof r.sound === 'boolean' ? r.sound : true
  };
}

/**
 * Coerce a persisted per-session effort-level map back into the strict
 * `EffortLevel` union. Strips entries with malformed values rather than
 * throwing — a legacy snapshot with stray keys shouldn't block boot.
 */
export function sanitizeEffortLevelMap(
  raw: unknown,
): Record<string, EffortLevel> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, EffortLevel> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      v === 'off' ||
      v === 'low' ||
      v === 'medium' ||
      v === 'high' ||
      v === 'xhigh' ||
      v === 'max'
    ) {
      out[k] = v;
    }
  }
  return out;
}

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

// Module-scoped set tracking in-flight db fetches, so rapid re-clicks on a
// session don't issue redundant IPC round-trips.
const inFlightLoads = new Set<string>();

/**
 * Project a sequence of CLI .jsonl frames (assistant / user / system / result)
 * into our store's MessageBlock format. Mirrors the live agent's reduction
 * (lifecycle.ts → streamEventToTranslation + setToolResult patches) but runs
 * synchronously over a finished transcript instead of subscribing to a stream.
 *
 * Used by importSession() to hydrate `messagesBySession[id]` immediately on
 * import — without this the imported chat looks empty until the user sends a
 * follow-up that triggers `--resume` and replays history. We deliberately
 * skip stream_event / control_request / control_response / agent_metadata
 * frames: those are runtime-only artifacts with no rendered representation.
 */
export function framesToBlocks(frames: unknown[]): MessageBlock[] {
  const out: MessageBlock[] = [];
  // Index maps to keep the projection O(n) over frame count instead of
  // O(n^2). Without these, dedupe-by-id and tool_result attach both call
  // `out.findIndex(...)` per frame — for a 96 MB / 33k-frame transcript
  // that's ~1.7s of pure linear scans on import. Keys mirror the lookup
  // predicates the previous findIndex calls used:
  //   - blockIdxById     : exact match on MessageBlock.id (dedupe append)
  //   - toolBlockIdxById : tool_use id → index for tool/todo blocks only
  //                        (matches the kind-narrowed findIndex below)
  const blockIdxById = new Map<string, number>();
  const toolBlockIdxById = new Map<string, number>();
  // Per-turn skill provenance threaded across frames so assistant text
  // generated after a Skill tool_use carries the `viaSkill` badge in
  // imported / hydrated history just like the live path (Task #318).
  let activeSkill: import('../types').SkillProvenance | null = null;
  for (const raw of frames) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as { type?: unknown };
    if (typeof f.type !== 'string') continue;
    // streamEventToTranslation already silently no-ops on unrecognized
    // types, so this is safe to feed everything to it.
    const { append, toolResults, nextActiveSkill } = streamEventToTranslation(
      f as { type: string },
      { activeSkill }
    );
    if (nextActiveSkill !== undefined) {
      activeSkill = nextActiveSkill;
    }
    if (append.length > 0) {
      // Coalesce by id — assistant messages spread across multiple frames
      // (parallel tool batches share the same message.id with different
      // tool_use ids in our block-id scheme, so this is mostly a defensive
      // dedupe rather than load-bearing). Skip duplicates by id.
      for (const b of append) {
        if (blockIdxById.has(b.id)) continue;
        const newIdx = out.length;
        out.push(b);
        blockIdxById.set(b.id, newIdx);
        if ((b.kind === 'tool' || b.kind === 'todo') && b.toolUseId) {
          toolBlockIdxById.set(b.toolUseId, newIdx);
        }
      }
    }
    for (const tr of toolResults) {
      const idx = toolBlockIdxById.get(tr.toolUseId);
      if (idx === undefined) continue;
      const target = out[idx];
      if (target.kind === 'tool') {
        out[idx] = { ...target, result: tr.result, isError: tr.isError };
      }
      // todo blocks don't carry result text, skip — TodoWrite returns void.
    }
    // Plain user-text frames aren't emitted by streamEventToTranslation
    // (the live path renders them via local-echo on send). For imported
    // history we DO need to surface them, otherwise the chat shows only
    // assistant turns. Pull text out of `message.content` here.
    if (f.type === 'user') {
      const userBlock = userFrameToBlock(raw);
      if (userBlock) {
        const newIdx = out.length;
        out.push(userBlock);
        blockIdxById.set(userBlock.id, newIdx);
      }
    }
  }
  return out;
}

function userFrameToBlock(raw: unknown): MessageBlock | null {
  const f = raw as { uuid?: unknown; message?: { content?: unknown } };
  const content = f.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === 'text' && typeof p.text === 'string') {
        text += (text ? '\n' : '') + p.text;
      }
      // Skip tool_result parts — those become tool block patches above.
    }
  }
  if (!text) return null;
  // Slash-command wrappers like `<command-name>...</command-name>` carry
  // synthetic metadata, not user-typed text. Filter them so the imported
  // chat looks like the user remembers it.
  if (text.startsWith('<command-')) return null;
  const id = typeof f.uuid === 'string' && f.uuid ? `u-${f.uuid}` : `u-${Math.random().toString(36).slice(2, 10)}`;
  return { kind: 'user', id, text };
}

/**
 * Truncation-marker text anchor: first 80 chars of the user message with
 * leading/trailing whitespace stripped and inner whitespace runs collapsed.
 * Both `rewindToBlock` (persist) and `loadMessages` (re-apply) call this so
 * the comparison is normalized. Length cap keeps app_state small even if
 * the truncated turn was a giant paste.
 */
function anchorTextPrefix(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Compact one-line summary of a tool input for the post-resolution trace
 * block. Picks the most descriptive scalar field (command/path/url/...) and
 * truncates aggressively — the user just needs a hint of what was decided,
 * not the full payload. Returns "" when nothing useful is present.
 */
function summarizeInputForTrace(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const PREFERRED = ['command', 'file_path', 'path', 'pattern', 'url', 'plan'];
  for (const k of PREFERRED) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 120 ? v.slice(0, 120) + '…' : v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  // Fallback: first scalar field by Object.entries order.
  for (const [, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 120 ? v.slice(0, 120) + '…' : v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
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
  recentProjects: [],
  userHome: '',
  claudeSettingsDefaultModel: null,
  activeId: '',
  focusedGroupId: null,
  model: '',
  permission: 'default',
  globalEffortLevel: DEFAULT_EFFORT_LEVEL,
  effortLevelBySession: {},
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  theme: 'system',
  fontSize: 'md',
  fontSizePx: 14,
  tutorialSeen: false,
  notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  messagesBySession: {},
  loadMessageErrors: {},
  startedSessions: {},
  runningSessions: {},
  statsBySession: {},
  contextUsageBySession: {},
  interruptedSessions: {},
  messageQueues: {},
  models: [],
  modelsLoaded: false,
  connection: null,
  hydrated: false,
  focusInputNonce: 0,
  installerCorrupt: false,
  composerInjectNonce: 0,
  composerInjectText: '',
  stashedDrafts: {},
  diagnostics: [],
  sessionInitFailures: {},
  allowAlwaysTools: [],
  openPopoverId: null,
  // task322: continue-after-interrupt
  lastTurnEnd: {},
  pendingDiffComments: {},

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
      userHome,
      claudeSettingsDefaultModel,
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
    // Default cwd is ALWAYS the user's home directory — no fallback chain,
    // no inheritance from prior sessions, no derivation from CLI history.
    // Per spec ("default cwd is home, no fallback chains"): the previous
    // historyRecentCwds → recentProjects → groupRecentCwd cascade silently
    // hijacked the new-session cwd from stale state, so we replaced it with
    // a single deterministic source. The user can repick via the StatusBar
    // cwd popover; that pick lands in the ccsm-owned `userCwds` LRU and
    // surfaces in the popover's recent column.
    const defaultCwd = userHome ?? '';
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
    // Bumping focusInputNonce here mirrors selectSession — clicking
    // "New Session" should also land focus in the composer.
    const targetGroup = baseGroups.find((g) => g.id === targetGroupId);
    const nextGroups =
      targetGroup && targetGroup.collapsed
        ? baseGroups.map((g) => (g.id === targetGroupId ? { ...g, collapsed: false } : g))
        : baseGroups;
    set((s) => ({
      sessions: [newSession, ...sessions],
      activeId: id,
      focusedGroupId: null,
      groups: nextGroups,
      focusInputNonce: s.focusInputNonce + 1
    }));
    // If the user explicitly created the session against a non-default cwd
    // (cwd override differs from home), record it in the ccsm-owned LRU so
    // it shows in the popover's recent column on subsequent opens. Fire-and-
    // forget — the IPC is best-effort and the renderer doesn't need the
    // post-update list (the popover refetches on each open).
    const finalCwd = newSession.cwd;
    if (finalCwd && userHome && finalCwd !== userHome) {
      const api = window.ccsm;
      void api?.userCwds?.push(finalCwd).catch(() => {});
    }
  },

  renameSession: (id, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x))
    }));
  },

  importSession: ({ name, cwd, groupId, resumeSessionId, projectDir }) => {
    const { sessions, groups, model, models, connection } = get();
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
    let initialModel = model;
    if (!initialModel) initialModel = connection?.model ?? '';
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
    // Hydrate the imported session's chat from its `.jsonl` so the user sees
    // the real history immediately, instead of an empty pane until they send
    // a follow-up. We need both `projectDir` (for the on-disk path) and the
    // resume sessionId; without `projectDir` we can't safely guess the
    // encoded directory, so we just leave the chat empty (graceful degrade).
    if (projectDir && typeof window !== 'undefined' && window.ccsm?.loadImportHistory) {
      const api = window.ccsm;
      void (async () => {
        try {
          const frames = await api.loadImportHistory(projectDir, resumeSessionId);
          if (!Array.isArray(frames) || frames.length === 0) return;
          const blocks = framesToBlocks(frames);
          if (blocks.length === 0) return;
          set((s) => ({
            messagesBySession: {
              ...s.messagesBySession,
              [id]: blocks
            }
          }));
          // PR-H: ccsm no longer mirrors history into SQLite, so on import
          // we just hydrate the in-memory store. Subsequent loads come
          // straight from the CLI's JSONL via `loadHistory`, which is the
          // same source we just read from.
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[store] importSession history load failed', err);
        }
      })();
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
      messages: prev.messagesBySession[id],
      draft: snapshotDraft(id),
      started: !!prev.startedSessions[id],
      running: !!prev.runningSessions[id],
      interrupted: !!prev.interruptedSessions[id],
      queue: prev.messageQueues[id],
      stats: prev.statsBySession[id],
      prevActiveId: prev.activeId
    };
    // Kill the spawned claude.exe BEFORE we clear store state. Without this,
    // deleting an actively-streaming session leaves a zombie child that
    // keeps burning tokens and whose stream events land on a removed id
    // (noisy warns + memory growth until the user quits the app). The IPC
    // is fire-and-forget because the cleanup in main.ts is synchronous from
    // our POV — it returns before the child fully exits, but the abort
    // signal has already fired by then. Guarded on `started || running` to
    // avoid a no-op round-trip for never-spawned sessions (restored ones).
    if (prev.startedSessions[id] || prev.runningSessions[id]) {
      void window.ccsm?.agentClose(id);
    }
    // Drop the renderer-side streamer accumulator. Without this, a deleted
    // session's PartialAssistantStreamer lingers in the lifecycle module map
    // — a tiny leak per delete, but adds up on long-running users who churn
    // sessions. Idempotent on never-streamed ids.
    disposeStreamer(id);
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
    // PR-H: ccsm no longer persists message history. The CLI's JSONL at
    // ~/.claude/projects/<key>/<sid>.jsonl is the canonical record and we
    // intentionally don't delete it here — losing the user's CLI-side
    // transcript when they remove a session from ccsm's UI would be a
    // surprising, lossy side-effect. The session is gone from ccsm's view,
    // which is what the user asked for.
    // Also drop any persisted draft for this session.
    deleteDrafts([id]);
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
      const messagesBySession =
        snapshot.messages !== undefined
          ? { ...s.messagesBySession, [snapshot.session.id]: snapshot.messages }
          : s.messagesBySession;
      const startedSessions = snapshot.started
        ? { ...s.startedSessions, [snapshot.session.id]: true as const }
        : s.startedSessions;
      // Intentionally DO NOT restore runningSessions / interruptedSessions:
      // the child claude.exe process tied to the deleted session was killed,
      // so resurrecting either flag leaves the UI permanently stuck (running
      // = perpetual spinner, no result frame will ever arrive; interrupted =
      // banner waiting for a `result.error_during_execution` that's gone with
      // the process). The session restarts from a clean post-turn state.
      const messageQueues =
        snapshot.queue !== undefined
          ? { ...s.messageQueues, [snapshot.session.id]: snapshot.queue }
          : s.messageQueues;
      const statsBySession =
        snapshot.stats !== undefined
          ? { ...s.statsBySession, [snapshot.session.id]: snapshot.stats }
          : s.statsBySession;
      return {
        sessions,
        activeId: snapshot.prevActiveId || s.activeId,
        messagesBySession,
        startedSessions,
        messageQueues,
        statsBySession
      };
    });
    // PR-H: history lives in the CLI's JSONL; restore is a no-op for it.
    // The in-memory reseed above is what makes undo instant; on a future
    // page reload, history reloads from the JSONL like any other session.
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
      void api?.userCwds?.push(cwd).catch(() => {});
    }
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

  setGlobalModel: (model) => {
    set({ model });
  },
  setSessionModel: (sessionId, model) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, model } : x))
    }));
    const api = window.ccsm;
    if (!api) return;
    if (get().startedSessions[sessionId]) {
      void api.agentSetModel(sessionId, model);
    }
  },
  setPermission: (permission) => {
    set({ permission });
    const api = window.ccsm;
    if (!api) return;
    // The enum value IS the CLI flag value — no translation needed.
    const started = Object.keys(get().startedSessions);
    if (started.length === 0) return;
    // For 'auto' we await the IPC so we can fall back to 'default' with a
    // toast if the SDK rejects (account/model gating). For other modes we
    // fire-and-forget — same behavior as before. We poll the first started
    // session's response since `auto` capability is account/model wide.
    if (permission === 'auto') {
      const probe = started[0];
      void Promise.resolve(api.agentSetPermissionMode(probe, permission)).then((res) => {
        if (res && res.ok === false) {
          set({ permission: 'default' });
          // Best-effort: tell remaining sessions to revert too.
          for (const id of started.slice(1)) void api.agentSetPermissionMode(id, 'default');
          const toast = (window as unknown as {
            __ccsmToast?: { push: (t: { kind: 'error'; title: string; body?: string }) => string };
          }).__ccsmToast;
          toast?.push({
            kind: 'error',
            title: i18next.t('permissions.autoUnsupportedTitle'),
            body: i18next.t('permissions.autoUnsupportedBody'),
          });
          return;
        }
        // Apply auto to remaining started sessions if the probe accepted.
        for (const id of started.slice(1)) void api.agentSetPermissionMode(id, permission);
      });
      return;
    }
    for (const id of started) void api.agentSetPermissionMode(id, permission);
  },
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setTheme: (theme) => set({ theme }),
  setFontSize: (fontSize) => set({ fontSize, fontSizePx: legacyFontSizeToPx(fontSize) }),
  setFontSizePx: (fontSizePx) => set({ fontSizePx, fontSize: pxToLegacyFontSize(fontSizePx) }),
  setSidebarWidth: (px) => set({ sidebarWidth: sanitizeSidebarWidth(px) }),
  resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT }),
  markTutorialSeen: () => set({ tutorialSeen: true }),

  setNotificationSettings: (patch) =>
    set((s) => ({ notificationSettings: { ...s.notificationSettings, ...patch } })),

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
        messages: prev.messagesBySession[s.id],
        draft: snapshotDraft(s.id),
        started: !!prev.startedSessions[s.id],
        running: !!prev.runningSessions[s.id],
        interrupted: !!prev.interruptedSessions[s.id],
        queue: prev.messageQueues[s.id],
        stats: prev.statsBySession[s.id],
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
      const nextMessages = { ...s.messagesBySession };
      const nextStarted = { ...s.startedSessions };
      const nextRunning = { ...s.runningSessions };
      const nextInterrupted = { ...s.interruptedSessions };
      const nextQueues = { ...s.messageQueues };
      for (const did of droppedIds) {
        delete nextMessages[did];
        delete nextStarted[did];
        delete nextRunning[did];
        delete nextInterrupted[did];
        delete nextQueues[did];
        // PR-H: ccsm no longer persists per-session history; nothing to wipe.
        // The CLI's JSONL stays on disk, mirroring deleteSession's policy.
      }
      return {
        groups: s.groups.filter((g) => g.id !== id),
        sessions: remainingSessions,
        activeId: nextActive,
        focusedGroupId: s.focusedGroupId === id ? null : s.focusedGroupId,
        messagesBySession: nextMessages,
        startedSessions: nextStarted,
        runningSessions: nextRunning,
        interruptedSessions: nextInterrupted,
        messageQueues: nextQueues
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
      const messagesBySession = { ...s.messagesBySession };
      const startedSessions = { ...s.startedSessions };
      const messageQueues = { ...s.messageQueues };
      const statsBySession = { ...s.statsBySession };
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
        if (snap.messages !== undefined) messagesBySession[snap.session.id] = snap.messages;
        if (snap.started) startedSessions[snap.session.id] = true;
        // Same rationale as restoreSession: do NOT restore running /
        // interrupted flags — the child process is dead, the flags would
        // strand the UI in a permanent transitional state.
        if (snap.queue !== undefined) messageQueues[snap.session.id] = snap.queue;
        if (snap.stats !== undefined) statsBySession[snap.session.id] = snap.stats;
      }
      return {
        groups,
        sessions,
        activeId: snapshot.prevActiveId || s.activeId,
        focusedGroupId: snapshot.prevFocusedGroupId,
        messagesBySession,
        startedSessions,
        messageQueues,
        statsBySession
      };
    });
    // PR-H: snapshot.messages is in-memory state; the JSONL on disk is
    // unchanged and remains the source of truth for future reloads.
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
      recentProjects: persisted.recentProjects ?? [],
      tutorialSeen: persisted.tutorialSeen ?? false,
      notificationSettings: migrateNotificationSettings(persisted.notificationSettings),
      globalEffortLevel: coerceEffortLevel(
        // Migration: any legacy `globalThinkingDefault` (off | default_on) on
        // disk maps to the new chip's default 'high' regardless of value.
        // Keeping a literal-by-literal mapping ('off' -> 'off', 'default_on'
        // -> 'high') was tempting but rejected: the old toggle's `off` was a
        // 2-state UI wart, not an explicit user preference for "no thinking
        // ever" — most users left it on the default. Resetting everyone to
        // 'high' is consistent with the new chip's default.
        (persisted as { globalEffortLevel?: unknown }).globalEffortLevel,
      ),
      effortLevelBySession: sanitizeEffortLevelMap(
        (persisted as { effortLevelBySession?: unknown }).effortLevelBySession,
      ),
    });
  }
  // Flip `hydrated` BEFORE kicking off the deferred IPCs below — components
  // that gate their first paint on this can stop showing skeleton state the
  // moment the persisted snapshot lands, even though connection/models may
  // still be in flight for another 100-500ms.
  useStore.setState({ hydrated: true });
  hydrated = true;
  trace.hydrateDoneAt = Date.now();
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
