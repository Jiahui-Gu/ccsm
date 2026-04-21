export type SessionState = 'idle' | 'waiting';

// MVP scope is single-agent. Keeping this as a discriminated string lets us
// add 'codex' / 'gemini' later without touching call sites that just key off it.
export type AgentType = 'claude-code';

export interface Session {
  id: string;
  name: string;
  state: SessionState;
  cwd: string;
  model: string;
  groupId: string;
  agentType: AgentType;
  /**
   * Endpoint this session spawns against. Missing = fall back to the store's
   * defaultEndpointId at spawn time. Intentionally optional so existing
   * persisted sessions (pre-endpoint-discovery) continue to work.
   */
  endpointId?: string;
  // Set when the session was imported from a Claude Code CLI transcript.
  // Passed to agentStart on first send so the SDK resumes the same thread.
  resumeSessionId?: string;
  // Per-session OS notification mute. When true, dispatch suppresses all
  // notification events for this session regardless of global settings.
  notificationsMuted?: boolean;
  // Per-session override of the global per-tool permission rules. When
  // present, `mergeRules(global, session)` determines the effective rules
  // passed to claude.exe via `--allowedTools` / `--disallowedTools`.
  // Omit to fall back to global rules untouched.
  permissionRules?: PermissionRules;
  // ── Optional git-worktree binding ───────────────────────────────────────
  // When `useWorktree` is true, the spawner asks WorktreeManager to create a
  // disposable worktree for this session on first start, and tears it down
  // on session close. The remaining fields are populated by the backend
  // after creation; the renderer only sets `useWorktree` (and optionally
  // `sourceBranch`) up front.
  useWorktree?: boolean;
  /**
   * Absolute filesystem path of the provisioned worktree. Populated by the
   * main process after the worktree is created; remains undefined for
   * sessions that don't use a worktree OR whose provisioning failed.
   */
  worktreePath?: string;
  /**
   * Friendly/branch name of the worktree (e.g. `claude/brave-turing-a1b2c3`).
   * Drives the branch pill shown in the sidebar row and status bar.
   */
  worktreeName?: string;
  /**
   * The branch the worktree was branched off from (user-selected at create
   * time). Purely informational — used in tooltips and future "merge back"
   * flows.
   */
  sourceBranch?: string;
}

// Fine-grained per-tool permission rules layered on top of `PermissionMode`.
// Patterns follow claude.exe's flag syntax:
//   - bare tool name         → "Bash", "Read"
//   - tool + pattern         → "Bash(git:*)", "Read(**/*.secret)"
//   - wildcard pattern       → "Bash(*)" (matches the user's own
//     ~/.claude/settings.json convention)
// Both arrays are passed as-is to the CLI — we do not translate patterns.
// Validation is sanity-only (non-empty, balanced parens) per MVP scope.
export interface PermissionRules {
  allowedTools: string[];
  disallowedTools: string[];
}

export const EMPTY_PERMISSION_RULES: PermissionRules = {
  allowedTools: [],
  disallowedTools: []
};

export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
  kind: 'normal' | 'archive' | 'deleted';
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

// A single image attached to a user message. `data` is raw base64 (no
// `data:...;base64,` prefix) so it can be dropped directly into an Anthropic
// content block as `source.data`. Persisted inline with the message block —
// ChatStream reconstructs a data-URL for thumbnail rendering on demand.
export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  data: string;
  size: number;
}

export type MessageBlock =
  | { kind: 'user'; id: string; text: string; images?: ImageAttachment[] }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; name: string; brief: string; expanded: boolean; toolUseId?: string; result?: string; isError?: boolean; input?: unknown }
  | { kind: 'todo'; id: string; toolUseId?: string; todos: TodoItem[] }
  | {
      kind: 'waiting';
      id: string;
      prompt: string;
      intent: 'permission' | 'plan' | 'question';
      requestId?: string;
      plan?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
    }
  | { kind: 'question'; id: string; requestId?: string; toolUseId?: string; questions: QuestionSpec[] }
  | { kind: 'status'; id: string; tone: 'info' | 'warn'; title: string; detail?: string }
  | {
      kind: 'pr-status';
      id: string;
      // Progress through the state machine: opening -> open -> polling ->
      // (done | failed). Rendered as a live-updating block in chat.
      phase: 'opening' | 'open' | 'polling' | 'done' | 'failed';
      number?: number;
      url?: string;
      base?: string;
      branch?: string;
      checks?: PrCheckStatus[];
      lastPollAt?: number;
      // Populated when any check reaches a terminal failing conclusion, so
      // the user can see log excerpts without opening the browser.
      failedLogs?: Array<{ name: string; snippet: string }>;
      error?: string;
    }
  | { kind: 'error'; id: string; text: string };

// Mirrors electron/pr.ts `PrCheck` — duplicated here because the renderer
// can't import main-process types.
export interface PrCheckStatus {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'neutral'
    | 'action_required'
    | null;
  detailsUrl?: string;
}
