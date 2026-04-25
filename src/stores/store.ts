import { create } from 'zustand';
import type { RecentProject } from '../mock/data';
import type { Group, Session, MessageBlock, ImageAttachment } from '../types';
import { loadPersisted, schedulePersist, PERSISTED_KEYS, type PersistedState, type PersistedKey } from './persist';
import { hydrateDrafts, deleteDrafts, snapshotDraft, restoreDraft } from './drafts';
import { i18next } from '../i18n';
import type { ConnectionInfo } from '../shared/ipc-types';
import { disposeStreamer } from '../agent/lifecycle';
import { streamEventToTranslation } from '../agent/stream-to-blocks';

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
   * Recent cwds derived from CLI transcripts at boot — fallback for fresh
   * userData where `recentProjects` is empty. Not persisted; rederived each
   * boot from `~/.claude/projects` via `window.ccsm.recentCwds()`.
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
  /** Tag/untag a session whose `cwd` has been detected as missing on disk.
   *  Set true by `agent:start` when the spawn would fail with ENOENT, and
   *  cleared automatically by `changeCwd` when the user repicks. */
  markSessionCwdMissing: (sessionId: string, missing: boolean) => void;
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
  setDensity: (density: Density) => void;
  setSidebarWidth: (px: number) => void;
  resetSidebarWidth: () => void;
  markTutorialSeen: () => void;
  setNotificationSettings: (patch: Partial<NotificationSettings>) => void;
  setSessionNotificationsMuted: (sessionId: string, muted: boolean) => void;

  createGroup: (name?: string) => string;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => GroupSnapshot | null;
  /** Re-insert a group + all its sessions captured by `deleteGroup`. */
  restoreGroup: (snapshot: GroupSnapshot) => void;
  archiveGroup: (id: string) => void;
  unarchiveGroup: (id: string) => void;
  setGroupCollapsed: (id: string, collapsed: boolean) => void;

  appendBlocks: (sessionId: string, blocks: MessageBlock[]) => void;
  /** Mark a `kind: 'question'` block as answered (or rejected via Esc). The
   *  sticky AskUserQuestion widget hides for this block once `answered`
   *  flips true; the timeline keeps the block in place but renders a
   *  compact summary row instead of the live card. Mirrors upstream's
   *  "card 出队 / timeline 留 result row" behavior. */
  markQuestionAnswered: (
    sessionId: string,
    blockId: string,
    payload: { answers: Record<string, string>; rejected: boolean }
  ) => void;
  streamAssistantText: (sessionId: string, blockId: string, appendText: string, done: boolean) => void;
  // (#336) Stream the in-flight `command` arg of a Bash tool_use as the
  // model types it. Creates a placeholder tool block on the first delta
  // (kind=tool, name=Bash, streamingInput=true) and updates
  // `bashPartialCommand` on subsequent deltas. The canonical assistant
  // `tool_use` event coalesces over this placeholder via shared id once
  // the input is fully formed; `done=true` only flips streamingInput off
  // pre-emptively in case the assistant frame is delayed.
  streamBashToolInput: (
    sessionId: string,
    toolBlockId: string,
    toolUseId: string,
    bashPartialCommand: string,
    done: boolean
  ) => void;
  setToolResult: (sessionId: string, toolUseId: string, result: string, isError: boolean) => void;
  clearMessages: (sessionId: string) => void;
  /** Wipe everything that pins a session to a specific claude.exe conversation
   *  (transcript, queue, started/running/interrupted flags, stats, resume id)
   *  WITHOUT removing the session row itself. After this runs the next user
   *  message triggers a fresh `agentStart` with no `--resume` — exactly what
   *  the CLI's `/clear` does. The Session entity (id, name, group, cwd) is
   *  preserved so the sidebar count is unchanged. */
  resetSessionContext: (sessionId: string) => void;
  /** Truncate the conversation to (but not including) `blockId`, dropping every
   *  message at or after that block. Also clears `resumeSessionId`, started/
   *  running/interrupted flags, and the queue, so the next send respawns a
   *  fresh `claude.exe` with no prior context. The agent's running process is
   *  closed via `agentClose` (best-effort). Used by the user-message hover
   *  menu's "Rewind from here" action — until the SDK exposes a server-side
   *  conversation rewind RPC, this is the safest local approximation. */
  rewindToBlock: (sessionId: string, blockId: string) => void;
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
  /** Per-hunk partial accept (#306, builds on the IPC landed in #242). The
   *  Edit/Write/MultiEdit permission prompt surfaces a checkbox per diff
   *  hunk; only the indices in `acceptedHunks` are forwarded to the agent
   *  via `agent:resolvePermissionPartial`. The waiting block is replaced by
   *  the same system trace as the whole-allow path so the chat retains a
   *  scrollable record. Empty array effectively denies the whole tool call. */
  resolvePermissionPartial: (sessionId: string, requestId: string, acceptedHunks: number[]) => void;
  /** Mark `toolName` as always-allowed for the rest of this app session. Future
   *  permission requests with the same `toolName` will auto-resolve Allow in
   *  `onAgentPermissionRequest` (see `agent/lifecycle.ts`). No-op if already
   *  present. Not persisted across restarts. */
  addAllowAlways: (toolName: string) => void;
  /** Increment `focusInputNonce` to ask the InputBar to take focus. Use after
   *  any user-driven action in the chat stream that should return focus to the
   *  composer (question submit, etc.). Permission/plan paths bump implicitly
   *  via `resolvePermission`. */
  bumpComposerFocus: () => void;
  /** Replace the composer text for the active session. See
   *  `composerInjectNonce` / `composerInjectText` for the pull-side mechanics. */
  injectComposerText: (text: string) => void;
  addSessionStats: (sessionId: string, delta: Partial<SessionStats>) => void;
  /** Replace the last-turn context-usage snapshot for `sessionId`. Pass a
   *  fresh object — we do NOT merge with prior state because each `result`
   *  frame already carries the absolute current-prompt size. */
  setSessionContextUsage: (sessionId: string, usage: SessionContextUsage) => void;

  loadModels: () => Promise<void>;
  loadConnection: () => Promise<void>;

  /** Flip the `installerCorrupt` banner on (true) or off (false). Called
   *  from `startSession` on `CLAUDE_NOT_FOUND`. */
  setInstallerCorrupt: (corrupt: boolean) => void;

  /** Push an agent-layer diagnostic (emitted by electron `agent:diagnostic`
   *  IPC). Caps at 20 entries; oldest trimmed. */
  pushDiagnostic: (entry: Omit<DiagnosticEntry, 'id' | 'dismissed'>) => void;
  /** Soft-dismiss a single diagnostic so the banner hides it. Kept in the
   *  array (not spliced) so a future "view recent diagnostics" surface could
   *  still read it without duplicating state. */
  dismissDiagnostic: (id: string) => void;
  /** Record that `agent:start` failed for this session with a non-bespoke
   *  error code. The UI surfaces an actionable banner. */
  setSessionInitFailure: (sessionId: string, fail: Omit<SessionInitFailure, 'timestamp'>) => void;
  /** Clear the init-failure flag after a successful retry or cwd/model repick. */
  clearSessionInitFailure: (sessionId: string) => void;

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

  /**
   * Add a per-line diff comment to `sessionId` (#303). Returns the new
   * comment id so callers can immediately put the chip into edit mode if
   * they want. Empty/whitespace text is rejected (no-op + returns '').
   */
  addDiffComment: (
    sessionId: string,
    args: { file: string; line: number; text: string },
  ) => string;
  /** Update an existing comment's text. No-op if the id is unknown.
   *  Trimmed-empty text deletes the comment instead. */
  updateDiffComment: (sessionId: string, commentId: string, text: string) => void;
  /** Remove a single comment. No-op if the id is unknown. */
  deleteDiffComment: (sessionId: string, commentId: string) => void;
  /** Drop ALL pending comments for `sessionId`. Called from the send path
   *  after a prompt has been consumed. */
  clearDiffComments: (sessionId: string) => void;
  // task322: continue-after-interrupt — explicit clear used when the user
  // sends any message (continue or otherwise) so the hint dismisses
  // immediately, before the round-trip that would clear it via setRunning.
  clearLastTurnEnd: (sessionId: string) => void;
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
        const idx = out.findIndex((x) => x.id === b.id);
        if (idx === -1) out.push(b);
      }
    }
    for (const tr of toolResults) {
      const idx = out.findIndex(
        (b) => (b.kind === 'tool' || b.kind === 'todo') && b.toolUseId === tr.toolUseId
      );
      if (idx === -1) continue;
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
      if (userBlock) out.push(userBlock);
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
  focusInputNonce: 0,
  installerCorrupt: false,
  composerInjectNonce: 0,
  composerInjectText: '',
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
    // task328: per-group cwd default — when the caller doesn't pin a cwd,
    // prefer the most-recent session in the target group that has a usable
    // cwd. `sessions` is ordered newest-first (createSession prepends), so
    // the first match is the most recent. Falls through to the global
    // recentProjects/historyRecentCwds defaults when the group is empty or
    // none of its sessions have a cwd. `(none)` chip placeholder appears
    // only when ALL of these resolve to empty.
    const groupRecentCwd = sessions.find(
      (x) => x.groupId === targetGroupId && !!x.cwd
    )?.cwd;
    const defaultCwd =
      groupRecentCwd ?? recentProjects[0]?.path ?? historyRecentCwds[0] ?? '';
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
  },

  renameSession: (id, name) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x))
    }));
  },

  importSession: ({ name, cwd, groupId, resumeSessionId, projectDir }) => {
    const { sessions, groups, model, models, connection } = get();
    // Imported sessions get a fresh local UUID (not the JSONL filename UUID)
    // so importing the same transcript twice doesn't collide. The original
    // CLI sid lives on as `resumeSessionId` and is forwarded to the SDK on
    // first send; the SDK is free to allocate a fresh sid for the resumed
    // conversation, which we then capture and pass back as our session id
    // on subsequent spawns (see startSession.ts).
    const id = newSessionId();
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

  appendBlocks: (sessionId, blocks) => {
    if (blocks.length === 0) return;
    set((s) => {
      const prev = s.messagesBySession[sessionId] ?? [];
      // Coalesce by id: if a block with the same id already exists (e.g. an
      // assistant text block built up by streaming deltas), replace it in
      // place with the finalized version rather than duplicating it.
      //
      // Defense-in-depth dedupe for AskUserQuestion: claude.exe surfaces the
      // SAME logical question twice — once via `can_use_tool` (becomes a
      // `question` block keyed by `q-${requestId}` carrying `requestId`) and
      // once via the assistant `tool_use` event (would key by
      // `${msgId}:tu${idx}` carrying `toolUseId`). Different ids, identical
      // intent. The id-based merge above can't catch this because the keys
      // differ. We additionally collapse a new `question` whose `toolUseId`
      // matches one already present, OR whose `requestId` matches. The
      // primary fix is to suppress the assistant-tool_use emission entirely
      // (see `assistantBlocks` in `stream-to-blocks.ts`); this guard is
      // belt-and-suspenders so a future regression — or a CLI version that
      // bypasses can_use_tool for AskUserQuestion — never causes two cards
      // to render and split the user's submit between two routing paths
      // (one of which leaves claude.exe blocked on a permission promise
      // that never settles, exits with code 1, and strands the UI in a
      // perpetual "running" state).
      let next = prev;
      const toAppend: MessageBlock[] = [];
      for (const b of blocks) {
        const idx = next.findIndex((x) => x.id === b.id);
        if (idx !== -1) {
          if (next === prev) next = prev.slice();
          next[idx] = b;
          continue;
        }
        if (b.kind === 'question') {
          const dupIdx = next.findIndex((x) => {
            if (x.kind !== 'question') return false;
            const xTu = (x as { toolUseId?: string }).toolUseId;
            const xReq = (x as { requestId?: string }).requestId;
            const bTu = (b as { toolUseId?: string }).toolUseId;
            const bReq = (b as { requestId?: string }).requestId;
            if (xTu && bTu && xTu === bTu) return true;
            if (xReq && bReq && xReq === bReq) return true;
            return false;
          });
          if (dupIdx !== -1) {
            // Keep the EXISTING block (it already carries any user state /
            // requestId wiring) — drop the new one. Don't replace, because
            // the can_use_tool path's block has the requestId we need for
            // routing, and we want to preserve that even if the assistant-
            // event block arrives later.
            continue;
          }
        }
        toAppend.push(b);
      }
      if (toAppend.length === 0 && next === prev) return s;
      // Perf: `concat` is consistently as fast or faster than spread for the
      // hot per-stream-chunk path; avoids the spread iterator overhead.
      const finalNext = toAppend.length > 0 ? next.concat(toAppend) : next;
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: finalNext }
      };
    });
  },

  markQuestionAnswered: (sessionId, blockId, payload) => {
    set((s) => {
      const prev = s.messagesBySession[sessionId] ?? [];
      const idx = prev.findIndex((b) => b.id === blockId);
      if (idx === -1) return s;
      const existing = prev[idx];
      if (existing.kind !== 'question') return s;
      // Idempotent: ignore double-submit (StrictMode, race with re-render).
      if (existing.answered) return s;
      const next = prev.slice();
      next[idx] = {
        ...existing,
        answered: true,
        answers: payload.answers,
        rejected: payload.rejected
      };
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next }
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

  streamBashToolInput: (sessionId, toolBlockId, toolUseId, bashPartialCommand, done) => {
    set((s) => {
      const prev = s.messagesBySession[sessionId] ?? [];
      const idx = prev.findIndex((b) => b.id === toolBlockId);
      if (idx === -1) {
        // First delta — create a placeholder Bash tool block. `brief` is
        // initialized to the partial command so the collapsed-row preview
        // shows the typed text immediately; ToolBlock will additionally
        // append a typing caret while `streamingInput` is true.
        const placeholder: MessageBlock = {
          kind: 'tool',
          id: toolBlockId,
          name: 'Bash',
          brief: bashPartialCommand,
          expanded: false,
          toolUseId,
          input: { command: bashPartialCommand },
          bashPartialCommand,
          streamingInput: !done
        };
        return {
          messagesBySession: { ...s.messagesBySession, [sessionId]: [...prev, placeholder] }
        };
      }
      const existing = prev[idx];
      if (existing.kind !== 'tool') return s;
      const next = prev.slice();
      next[idx] = {
        ...existing,
        brief: bashPartialCommand,
        bashPartialCommand,
        streamingInput: !done,
        input: { command: bashPartialCommand }
      };
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
      const nextContextUsage = { ...s.contextUsageBySession };
      delete nextContextUsage[sessionId];
      // Drop resumeSessionId so the next agentStart spawns a fresh
      // claude.exe conversation rather than continuing the old one. Also
      // reset state to 'idle' — clearing the context while the row is
      // still flagged 'waiting' would leave the sidebar dot lit forever
      // (no result frame is coming for the conversation we just dropped).
      const nextSessions = s.sessions.map((x) => {
        if (x.id !== sessionId) return x;
        const cleaned = x.resumeSessionId === undefined ? x : (() => {
          const { resumeSessionId: _drop, ...rest } = x;
          return rest as typeof x;
        })();
        return cleaned.state === 'idle' ? cleaned : { ...cleaned, state: 'idle' as const };
      });
      return {
        sessions: nextSessions,
        messagesBySession: nextMessages,
        startedSessions: nextStarted,
        runningSessions: nextRunning,
        interruptedSessions: nextInterrupted,
        messageQueues: nextQueues,
        statsBySession: nextStats,
        contextUsageBySession: nextContextUsage
      };
    });
    // PR-H: ccsm no longer persists message history. The CLI's JSONL stays
    // on disk untouched — a reset clears ccsm's view but doesn't delete the
    // user's CLI-side transcript.
  },

  replaceMessages: (sessionId, blocks) => {
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: blocks }
    }));
  },

  rewindToBlock: (sessionId, blockId) => {
    set((s) => {
      const prev = s.messagesBySession[sessionId];
      if (!prev) return s;
      const idx = prev.findIndex((b) => b.id === blockId);
      if (idx < 0) return s;
      const truncated = prev.slice(0, idx);
      // Drop every flag that pins this session to the now-orphaned claude.exe
      // conversation: started, running, interrupted, queue, resumeSessionId.
      // Stats are intentionally preserved — they're the user's lifetime spend
      // for this session, not bound to a single conversation turn.
      const nextStarted = { ...s.startedSessions };
      delete nextStarted[sessionId];
      const nextRunning = { ...s.runningSessions };
      delete nextRunning[sessionId];
      const nextInterrupted = { ...s.interruptedSessions };
      delete nextInterrupted[sessionId];
      const nextQueues = { ...s.messageQueues };
      delete nextQueues[sessionId];
      const nextSessions = s.sessions.map((x) => {
        if (x.id !== sessionId) return x;
        const cleaned = x.resumeSessionId === undefined ? x : (() => {
          const { resumeSessionId: _drop, ...rest } = x;
          return rest as typeof x;
        })();
        return cleaned.state === 'idle' ? cleaned : { ...cleaned, state: 'idle' as const };
      });
      return {
        sessions: nextSessions,
        messagesBySession: { ...s.messagesBySession, [sessionId]: truncated },
        startedSessions: nextStarted,
        runningSessions: nextRunning,
        interruptedSessions: nextInterrupted,
        messageQueues: nextQueues
      };
    });
    // Best-effort: close the running agent so the next send respawns. If it's
    // already gone (or there was no agent yet), the IPC just no-ops.
    void window.ccsm?.agentClose(sessionId);
  },

  addSessionStats: (sessionId, delta) => {
    set((s) => {
      const prev = s.statsBySession[sessionId] ?? EMPTY_SESSION_STATS;
      // Guard against NaN / Infinity / non-number deltas: a single bad
      // `result` frame (missing field, JSON quirk) would otherwise poison
      // the running totals forever — once a number becomes NaN, every
      // future addition stays NaN. Coerce non-finite to 0 silently.
      const safe = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const next: SessionStats = {
        turns: prev.turns + safe(delta.turns),
        inputTokens: prev.inputTokens + safe(delta.inputTokens),
        outputTokens: prev.outputTokens + safe(delta.outputTokens),
        costUsd: prev.costUsd + safe(delta.costUsd)
      };
      return { statsBySession: { ...s.statsBySession, [sessionId]: next } };
    });
  },

  setSessionContextUsage: (sessionId, usage) => {
    set((s) => ({
      contextUsageBySession: {
        ...s.contextUsageBySession,
        [sessionId]: usage
      }
    }));
  },

  loadMessages: async (sessionId) => {
    const api = window.ccsm;
    if (!api || typeof api.loadHistory !== 'function') return;
    if (inFlightLoads.has(sessionId)) return;
    // Look up the session so we can derive the on-disk JSONL location.
    // CLI writes to ~/.claude/projects/<slug(cwd)>/<sid>.jsonl; we need
    // both cwd and the right sid (resumed imports keep the original CLI
    // sid in `resumeSessionId`; fresh sessions use ccsm's local id which
    // we forwarded to the SDK as its `sessionId`, so the filenames match).
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const cwd = session.cwd ?? '';
    const sidOnDisk = session.resumeSessionId || session.id;
    if (!cwd) {
      // No cwd → no project key → can't locate the JSONL. Treat as empty
      // (don't surface an error; cwd-less sessions are a transient state
      // during creation and the renderer handles `[]` gracefully).
      set((s) => ({
        messagesBySession:
          sessionId in s.messagesBySession
            ? s.messagesBySession
            : { ...s.messagesBySession, [sessionId]: [] }
      }));
      return;
    }
    inFlightLoads.add(sessionId);
    // Clear any stale load error for this session before attempting.
    set((s) => {
      if (!(sessionId in s.loadMessageErrors)) return s;
      const next = { ...s.loadMessageErrors };
      delete next[sessionId];
      return { loadMessageErrors: next };
    });
    try {
      let result: Awaited<ReturnType<typeof api.loadHistory>>;
      try {
        result = await api.loadHistory(cwd, sidOnDisk);
      } catch (err) {
        // IPC-layer failure (preload missing, channel unregistered). Seed
        // a sentinel so we don't infinite-retry, and surface the error so
        // the user sees the inline retry banner instead of a stuck pane.
        console.warn(`[store] loadHistory(${sessionId}) IPC failed:`, err);
        const message = err instanceof Error ? err.message : String(err);
        set((s) => ({
          messagesBySession:
            sessionId in s.messagesBySession
              ? s.messagesBySession
              : { ...s.messagesBySession, [sessionId]: [] },
          loadMessageErrors: { ...s.loadMessageErrors, [sessionId]: message }
        }));
        return;
      }
      let frames: unknown[] = [];
      if (result.ok) {
        frames = result.frames;
      } else if (result.error === 'not_found') {
        // No JSONL on disk yet — fresh session that hasn't received its
        // first frame, or one that was never run via the CLI. Empty array
        // is the right answer; not an error.
        frames = [];
      } else {
        // Real read error (permission, malformed path, fs failure).
        const detail = 'detail' in result && result.detail ? `: ${result.detail}` : '';
        const message = `${result.error}${detail}`;
        console.warn(`[store] loadHistory(${sessionId}) failed: ${message}`);
        set((s) => ({
          messagesBySession:
            sessionId in s.messagesBySession
              ? s.messagesBySession
              : { ...s.messagesBySession, [sessionId]: [] },
          loadMessageErrors: { ...s.loadMessageErrors, [sessionId]: message }
        }));
        return;
      }
      // Project raw CLI frames into MessageBlock[] using the same reducer
      // the import path uses. JSONL is the canonical persistence format
      // now (PR-H), so we always go through this projection.
      const projected = framesToBlocks(frames);
      // Sanitize: a streaming=true assistant block inside the JSONL means
      // a previous run crashed mid-stream. Drop the flag so the UI doesn't
      // show a perpetual pulse on restore.
      const sanitized: MessageBlock[] = projected.map((r) =>
        r.kind === 'assistant' && (r as { streaming?: boolean }).streaming
          ? { ...r, streaming: false }
          : r
      );
      set((s) => {
        const existing = s.messagesBySession[sessionId];
        if (!existing) {
          // First-load fast path.
          return {
            messagesBySession: {
              ...s.messagesBySession,
              [sessionId]: sanitized
            }
          };
        }
        // Merge path: streaming may have appended blocks while we awaited
        // the disk round-trip. Prepend persisted blocks whose ids aren't
        // already present — every MessageBlock variant carries an id.
        const existingIds = new Set(existing.map((b) => b.id));
        const additions = sanitized.filter((b) => !existingIds.has(b.id));
        if (additions.length === 0) return s;
        return {
          messagesBySession: {
            ...s.messagesBySession,
            [sessionId]: [...additions, ...existing]
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
      // task322: a fresh turn starting clears any prior interrupt-hint state
      // for this session. The hint is meant to bridge the gap between Stop
      // and the next user keystroke — once a turn is back in flight, it's
      // stale by definition.
      const patch: Partial<State> = { runningSessions: next };
      if (running && s.lastTurnEnd[sessionId]) {
        const nextLte = { ...s.lastTurnEnd };
        delete nextLte[sessionId];
        patch.lastTurnEnd = nextLte;
      }
      return patch;
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
    set((s) => {
      const patch: Partial<State> = {};
      if (!s.interruptedSessions[sessionId]) {
        patch.interruptedSessions = { ...s.interruptedSessions, [sessionId]: true };
      }
      // task322: record interrupt as the turn-end disposition so the InputBar
      // can offer a "press Enter to continue" hint. Survives the imminent
      // result-frame which only consumes `interruptedSessions`.
      if (s.lastTurnEnd[sessionId] !== 'interrupted') {
        patch.lastTurnEnd = { ...s.lastTurnEnd, [sessionId]: 'interrupted' };
      }
      return Object.keys(patch).length === 0 ? s : patch;
    });
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
      const idx = prev.findIndex((b) => b.id === waitId);
      if (idx === -1) return s;
      // Replace the waiting block in place with a compact system trace so
      // the chat retains a scrollable record of what the user allowed/denied
      // (instead of the prompt vanishing without a trace). Keep the original
      // ordering — important for sequential prompts.
      const wait = prev[idx];
      const toolName = wait.kind === 'waiting' ? (wait.toolName ?? 'tool') : 'tool';
      const toolInput = wait.kind === 'waiting' ? wait.toolInput : undefined;
      const toolInputSummary = summarizeInputForTrace(toolInput);
      const trace: MessageBlock = {
        kind: 'system',
        id: `perm-resolved-${requestId}`,
        subkind: 'permission-resolved',
        toolName,
        toolInputSummary,
        decision: decision === 'allow' ? 'allowed' : 'denied',
        timestamp: Date.now()
      };
      const next = prev.slice();
      next[idx] = trace;
      // Centralized focus policy: after the user resolves any in-stream
      // permission/plan prompt, focus returns to the composer so the next
      // keystroke types into the chat. InputBar's effect guards against
      // stealing focus from other text-entry surfaces (rename input,
      // dialog field, IME composition).
      //
      // EXCEPTION: if another in-stream wait block is still pending for this
      // session (sequential permission/plan prompts, or a queued
      // ask-question), DO NOT bump composer focus. Otherwise the composer
      // briefly grabs focus, the next prompt mounts, sees a focused textarea
      // and (correctly) refuses to steal it — stranding focus on the empty
      // composer instead of the new Reject button.
      const hasPendingWait = next.some(
        (b) => b.kind === 'waiting' || b.kind === 'question'
      );
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next },
        focusInputNonce: hasPendingWait ? s.focusInputNonce : s.focusInputNonce + 1
      };
    });
    void window.ccsm?.agentResolvePermission(sessionId, requestId, decision);
  },

  resolvePermissionPartial: (sessionId, requestId, acceptedHunks) => {
    const waitId = `wait-${requestId}`;
    set((s) => {
      const prev = s.messagesBySession[sessionId];
      if (!prev) return s;
      const idx = prev.findIndex((b) => b.id === waitId);
      if (idx === -1) return s;
      const wait = prev[idx];
      const toolName = wait.kind === 'waiting' ? (wait.toolName ?? 'tool') : 'tool';
      const toolInput = wait.kind === 'waiting' ? wait.toolInput : undefined;
      const toolInputSummary = summarizeInputForTrace(toolInput);
      // Trace decision mirrors the whole-allow/deny shape; "allowed" when at
      // least one hunk was accepted, "denied" when none were. The granular
      // hunk indices live on the IPC, not in the trace — keep the chat
      // readout simple.
      const decision: 'allowed' | 'denied' = acceptedHunks.length > 0 ? 'allowed' : 'denied';
      const trace: MessageBlock = {
        kind: 'system',
        id: `perm-resolved-${requestId}`,
        subkind: 'permission-resolved',
        toolName,
        toolInputSummary,
        decision,
        timestamp: Date.now()
      };
      const next = prev.slice();
      next[idx] = trace;
      const hasPendingWait = next.some(
        (b) => b.kind === 'waiting' || b.kind === 'question'
      );
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next },
        focusInputNonce: hasPendingWait ? s.focusInputNonce : s.focusInputNonce + 1
      };
    });
    void window.ccsm?.agentResolvePermissionPartial(sessionId, requestId, acceptedHunks);
  },

  addAllowAlways: (toolName) => {
    if (!toolName) return;
    set((s) => {
      if (s.allowAlwaysTools.includes(toolName)) return s;
      return { allowAlwaysTools: [...s.allowAlwaysTools, toolName] };
    });
  },

  bumpComposerFocus: () => {
    set((s) => ({ focusInputNonce: s.focusInputNonce + 1 }));
  },

  /** Inject text into the composer for the active session and focus it.
   *  Used by the user-message hover menu's Edit action. The InputBar watches
   *  `composerInjectNonce` and, when it ticks, replaces its value with the
   *  current `composerInjectText`. We bump the focus nonce too so the textarea
   *  ends up focused with the cursor at the end (matches the "edit and resend"
   *  expectation: drop the user back into the composer ready to tweak + send). */
  injectComposerText: (text: string) => {
    set((s) => ({
      composerInjectText: text,
      composerInjectNonce: s.composerInjectNonce + 1,
      focusInputNonce: s.focusInputNonce + 1
    }));
  },

  openPopover: (id) => {
    set((s) => (s.openPopoverId === id ? s : { openPopoverId: id }));
  },

  closePopover: (id) => {
    set((s) => (s.openPopoverId === id ? { openPopoverId: null } : s));
  },

  // ─── #303 per-line diff comments ────────────────────────────────────────
  // Storage shape: pendingDiffComments[sessionId][commentId] = comment.
  // Per-session because multiple sessions can each have their own pending
  // feedback; the InputBar.send path of the active session consumes only
  // its own bucket. Comments survive session-switch (so the user can keep
  // typing on session B then return to A and still see the chips), but not
  // app reload (in-memory only — see State.pendingDiffComments doc).
  addDiffComment: (sessionId, args) => {
    const text = args.text.trim();
    if (!sessionId || !text) return '';
    // Dedupe: at most one comment per (sessionId, file, line). A second
    // addDiffComment for the same anchor REPLACES the existing entry
    // (overwrite text, bump updatedAt, keep id + createdAt) instead of
    // stacking. Reusing the id keeps DiffView's data-diff-comment-id DOM
    // lookups stable across the replace.
    const existing = get().pendingDiffComments[sessionId];
    if (existing) {
      const dup = Object.values(existing).find(
        (c) => c.file === args.file && c.line === args.line,
      );
      if (dup) {
        set((s) => {
          const bucket = s.pendingDiffComments[sessionId];
          if (!bucket || !bucket[dup.id]) return s;
          return {
            pendingDiffComments: {
              ...s.pendingDiffComments,
              [sessionId]: {
                ...bucket,
                [dup.id]: { ...bucket[dup.id], text, updatedAt: Date.now() },
              },
            },
          };
        });
        return dup.id;
      }
    }
    const id = nextId('dfc');
    set((s) => {
      const prev = s.pendingDiffComments[sessionId] ?? {};
      return {
        pendingDiffComments: {
          ...s.pendingDiffComments,
          [sessionId]: {
            ...prev,
            [id]: {
              id,
              file: args.file,
              line: args.line,
              text,
              createdAt: Date.now(),
            },
          },
        },
      };
    });
    return id;
  },

  updateDiffComment: (sessionId, commentId, text) => {
    const trimmed = text.trim();
    set((s) => {
      const bucket = s.pendingDiffComments[sessionId];
      if (!bucket || !bucket[commentId]) return s;
      // Empty body = delete: matches the "trash icon" semantics of clearing
      // the textarea and saving. Saves the user one extra click.
      if (!trimmed) {
        const nextBucket = { ...bucket };
        delete nextBucket[commentId];
        const nextAll = { ...s.pendingDiffComments };
        if (Object.keys(nextBucket).length === 0) delete nextAll[sessionId];
        else nextAll[sessionId] = nextBucket;
        return { pendingDiffComments: nextAll };
      }
      return {
        pendingDiffComments: {
          ...s.pendingDiffComments,
          [sessionId]: {
            ...bucket,
            [commentId]: { ...bucket[commentId], text: trimmed },
          },
        },
      };
    });
  },

  deleteDiffComment: (sessionId, commentId) => {
    set((s) => {
      const bucket = s.pendingDiffComments[sessionId];
      if (!bucket || !bucket[commentId]) return s;
      const nextBucket = { ...bucket };
      delete nextBucket[commentId];
      const nextAll = { ...s.pendingDiffComments };
      if (Object.keys(nextBucket).length === 0) delete nextAll[sessionId];
      else nextAll[sessionId] = nextBucket;
      return { pendingDiffComments: nextAll };
    });
  },

  clearDiffComments: (sessionId) => {
    set((s) => {
      if (!s.pendingDiffComments[sessionId]) return s;
      const nextAll = { ...s.pendingDiffComments };
      delete nextAll[sessionId];
      return { pendingDiffComments: nextAll };
    });
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

  pushDiagnostic: (entry) => {
    set((s) => {
      const id = nextId('diag');
      const next: DiagnosticEntry = { id, dismissed: false, ...entry };
      // Cap at 20 — diagnostics are ephemeral and the UI only renders the
      // latest one anyway. Trim from the front so the newest stays at index
      // length-1 (cheap lookup when picking what to render).
      const combined = [...s.diagnostics, next];
      const trimmed = combined.length > 20 ? combined.slice(combined.length - 20) : combined;
      return { diagnostics: trimmed };
    });
  },
  dismissDiagnostic: (id) => {
    set((s) => {
      let changed = false;
      const next = s.diagnostics.map((d) => {
        if (d.id !== id || d.dismissed) return d;
        changed = true;
        return { ...d, dismissed: true };
      });
      return changed ? { diagnostics: next } : s;
    });
  },
  setSessionInitFailure: (sessionId, fail) => {
    set((s) => ({
      sessionInitFailures: {
        ...s.sessionInitFailures,
        [sessionId]: { ...fail, timestamp: Date.now() },
      },
    }));
  },
  clearSessionInitFailure: (sessionId) => {
    set((s) => {
      if (!(sessionId in s.sessionInitFailures)) return s;
      const next = { ...s.sessionInitFailures };
      delete next[sessionId];
      return { sessionInitFailures: next };
    });
  },
  // task322: continue-after-interrupt — explicit clear used when the user
  // sends any message so the hint dismisses without waiting for the next
  // turn to start (which is when setRunning(true) would otherwise wipe it).
  clearLastTurnEnd: (sessionId) => {
    set((s) => {
      if (!s.lastTurnEnd[sessionId]) return s;
      const next = { ...s.lastTurnEnd };
      delete next[sessionId];
      return { lastTurnEnd: next };
    });
  },
}));

let hydrated = false;

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

  // Seed history-derived defaults from CLI transcripts. Fresh Electron
  // userData starts with empty `recentProjects` and no `model`; without this
  // the new-session picker falls back to '' (chip `(none)` placeholder) and
  // the first endpoint's first model regardless of what the user actually
  // uses in the CLI.
  try {
    const api = window.ccsm;
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
