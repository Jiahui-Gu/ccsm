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
  // Set when the session was imported from a Claude Code CLI transcript.
  // Passed to agentStart on first send so the SDK resumes the same thread.
  resumeSessionId?: string;
  // Per-session OS notification mute. When true, dispatch suppresses all
  // notification events for this session regardless of global settings.
  notificationsMuted?: boolean;
  // Marks a session whose persisted `cwd` no longer exists on disk (e.g.
  // a directory that was deleted between app runs — common after the
  // worktree feature was reverted). Set by `hydrateStore` via a best-effort
  // existence probe and cleared the next time the user repicks a cwd.
  // Surfaced in the Sidebar (dim row + tooltip) and in `agent:start`
  // (returns `errorCode: 'CWD_MISSING'` so InputBar can prompt the user
  // to repick via the StatusBar cwd chip).
  cwdMissing?: boolean;
}

export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
  kind: 'normal' | 'archive';
  /**
   * When set, the sidebar should render `t(nameKey)` instead of `name`.
   * Used by groups synthesized at session-create / import time so the
   * default-group label re-localizes when the user switches language,
   * instead of staying frozen to whatever the current locale was when
   * the group was created. `name` is still populated with the resolved
   * string at creation time as a fallback for any non-i18n surface.
   */
  nameKey?: string;
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

// Provenance marker on assistant text blocks emitted while a Skill tool
// invocation is in flight for the current turn. Surfaced as a small
// "via skill: <name>" badge in AssistantBlock so users can tell when a
// reply is being driven by a Skill (Task #318) — this is discoverability,
// not a quality signal: skills running is correct behavior.
export interface SkillProvenance {
  // The skill name as the Skill tool received it (e.g. "using-superpowers"
  // or "pua:pua-loop"). Plugin-namespaced skills carry the `<plugin>:<skill>`
  // form and are rendered verbatim.
  name: string;
  // Best-effort filesystem path for the tooltip. Renderer-side derivation
  // since the renderer can't list disk; matches the convention in
  // electron/commands-loader.ts (skills under ~/.claude/skills/<name> or
  // ~/.claude/plugins/<plugin>/skills/<skill>).
  path?: string;
}

export type MessageBlock =
  | { kind: 'user'; id: string; text: string; images?: ImageAttachment[] }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; viaSkill?: SkillProvenance }
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
      kind: 'system';
      id: string;
      // Discriminator for future system block variants. Today: only the
      // post-resolution permission trace replaces a withdrawn waiting block,
      // so the chat retains a scrollable record of what was allowed/denied.
      subkind: 'permission-resolved';
      toolName: string;
      toolInputSummary: string;
      decision: 'allowed' | 'denied';
      timestamp: number;
    }
  | { kind: 'error'; id: string; text: string };
