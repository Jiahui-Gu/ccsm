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
}

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

export type MessageBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; brief: string; expanded: boolean; toolUseId?: string; result?: string; isError?: boolean; input?: unknown }
  | { kind: 'todo'; id: string; toolUseId?: string; todos: TodoItem[] }
  | { kind: 'waiting'; id: string; prompt: string; intent: 'permission' | 'plan' | 'question'; requestId?: string; plan?: string }
  | { kind: 'question'; id: string; requestId: string; questions: QuestionSpec[] }
  | { kind: 'status'; id: string; tone: 'info' | 'warn'; title: string; detail?: string }
  | { kind: 'error'; id: string; text: string };
