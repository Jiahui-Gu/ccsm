import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type StartOpts = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
};

type StartResult = { ok: true } | { ok: false; error: string };
type AgentEvent = { sessionId: string; message: SDKMessage };
type AgentExit = { sessionId: string; error?: string };

declare global {
  interface Window {
    agentory?: {
      loadState: (key: string) => Promise<string | null>;
      saveState: (key: string, value: string) => Promise<void>;
      getDataDir: () => Promise<string>;
      getVersion: () => Promise<string>;
      getApiKey: () => Promise<string>;
      setApiKey: (value: string) => Promise<boolean>;
      hasEncryption: () => Promise<boolean>;

      agentStart: (sessionId: string, opts: StartOpts) => Promise<StartResult>;
      agentSend: (sessionId: string, text: string) => Promise<boolean>;
      agentInterrupt: (sessionId: string) => Promise<boolean>;
      agentSetPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<boolean>;
      agentSetModel: (sessionId: string, model?: string) => Promise<boolean>;
      agentClose: (sessionId: string) => Promise<boolean>;
      onAgentEvent: (handler: (e: AgentEvent) => void) => () => void;
      onAgentExit: (handler: (e: AgentExit) => void) => () => void;
    };
  }
}

export {};
