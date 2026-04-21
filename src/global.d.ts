import type { CliPermissionMode } from './agent/permission';
import type { ClaudeStreamEvent } from '../electron/agent/stream-json-types';

type PermissionMode = CliPermissionMode;
type AgentMessage = ClaudeStreamEvent;

type StartOpts = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  endpointId?: string;
};

type StartResult = { ok: true } | { ok: false; error: string };
type AgentEvent = { sessionId: string; message: AgentMessage };
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

type EndpointKindDecl = 'anthropic';
type EndpointStatusDecl = 'ok' | 'error' | 'unchecked';
type EndpointRowDecl = {
  id: string;
  name: string;
  baseUrl: string;
  kind: EndpointKindDecl;
  isDefault: boolean;
  lastStatus: EndpointStatusDecl;
  lastError: string | null;
  lastRefreshedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
type ModelRowDecl = {
  id: string;
  endpointId: string;
  modelId: string;
  displayName: string | null;
  discoveredAt: number;
};
type EndpointWithModelsDecl = EndpointRowDecl & { models: ModelRowDecl[] };
type TestConnectionResultDecl =
  | { ok: true }
  | { ok: false; status?: number; error: string };
type RefreshResultDecl =
  | { ok: true; count: number }
  | { ok: false; error: string; status?: number };

declare global {
  interface Window {
    agentory?: {
      loadState: (key: string) => Promise<string | null>;
      saveState: (key: string, value: string) => Promise<void>;
      loadMessages: (sessionId: string) => Promise<unknown[]>;
      saveMessages: (sessionId: string, blocks: Array<{ id: string; kind: string }>) => Promise<void>;
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

      notify: (payload: { sessionId: string; title: string; body?: string }) => Promise<boolean>;
      onNotificationFocus: (handler: (sessionId: string) => void) => () => void;

      updatesStatus: () => Promise<UpdateStatus>;
      updatesCheck: () => Promise<UpdateStatus>;
      updatesDownload: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesInstall: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      onUpdateStatus: (handler: (s: UpdateStatus) => void) => () => void;

      window: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<boolean>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        onMaximizedChanged: (handler: (max: boolean) => void) => () => void;
        platform: 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';
      };

      endpoints: {
        list: () => Promise<EndpointRowDecl[]>;
        add: (input: {
          name: string;
          baseUrl: string;
          kind?: EndpointKindDecl;
          apiKey?: string;
          isDefault?: boolean;
        }) => Promise<EndpointRowDecl>;
        update: (
          id: string,
          patch: { name?: string; baseUrl?: string; apiKey?: string | null; isDefault?: boolean }
        ) => Promise<EndpointRowDecl | null>;
        remove: (id: string) => Promise<boolean>;
        testConnection: (args: { baseUrl: string; apiKey: string }) => Promise<TestConnectionResultDecl>;
        refreshModels: (id: string) => Promise<RefreshResultDecl>;
      };

      models: {
        listByEndpoint: (id: string) => Promise<ModelRowDecl[]>;
        listAll: () => Promise<EndpointWithModelsDecl[]>;
      };
    };
  }
}

export {};
