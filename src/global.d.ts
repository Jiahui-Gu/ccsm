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
type AgentPermissionRequest = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
};

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string }
  | { kind: 'not-available'; version: string }
  | { kind: 'downloading'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

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
      pickDirectory: () => Promise<string | null>;

      agentStart: (sessionId: string, opts: StartOpts) => Promise<StartResult>;
      agentSend: (sessionId: string, text: string) => Promise<boolean>;
      agentInterrupt: (sessionId: string) => Promise<boolean>;
      agentSetPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<boolean>;
      agentSetModel: (sessionId: string, model?: string) => Promise<boolean>;
      agentClose: (sessionId: string) => Promise<boolean>;
      agentResolvePermission: (
        sessionId: string,
        requestId: string,
        decision: 'allow' | 'deny'
      ) => Promise<boolean>;
      onAgentEvent: (handler: (e: AgentEvent) => void) => () => void;
      onAgentExit: (handler: (e: AgentExit) => void) => () => void;
      onAgentPermissionRequest: (handler: (e: AgentPermissionRequest) => void) => () => void;

      scanImportable: () => Promise<
        Array<{ sessionId: string; cwd: string; title: string; mtime: number; projectDir: string }>
      >;

      updatesStatus: () => Promise<UpdateStatus>;
      updatesCheck: () => Promise<UpdateStatus>;
      updatesDownload: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesInstall: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      onUpdateStatus: (handler: (s: UpdateStatus) => void) => () => void;
    };
  }
}

export {};
