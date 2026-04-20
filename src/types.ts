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
}

export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
  kind: 'normal' | 'archive' | 'deleted';
}

export type MessageBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; brief: string; expanded: boolean; toolUseId?: string; result?: string; isError?: boolean }
  | { kind: 'waiting'; id: string; prompt: string; intent: 'permission' | 'plan' | 'question'; requestId?: string }
  | { kind: 'error'; id: string; text: string };
