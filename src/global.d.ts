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

type StartResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      errorCode?: 'CLAUDE_NOT_FOUND' | 'CWD_MISSING';
      searchedPaths?: string[];
    };
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

type EndpointKindDecl =
  | 'anthropic'
  | 'openai-compat'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'unknown';
type EndpointStatusDecl = 'ok' | 'error' | 'unchecked';
type DiscoverySourceDecl = 'listed' | 'cli-picker' | 'env-override' | 'fallback' | 'manual';
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
  detectedKind: EndpointKindDecl | null;
  manualModelIds: string[];
};
type ModelRowDecl = {
  id: string;
  endpointId: string;
  modelId: string;
  displayName: string | null;
  discoveredAt: number;
  source: DiscoverySourceDecl;
  existsConfirmed: boolean;
};
type EndpointWithModelsDecl = EndpointRowDecl & { models: ModelRowDecl[] };
type TestConnectionResultDecl =
  | { ok: true }
  | { ok: false; status?: number; error: string };
type RefreshResultDecl =
  | {
      ok: true;
      count: number;
      detectedKind: EndpointKindDecl;
      sourceStats: Record<DiscoverySourceDecl, number>;
    }
  | { ok: false; error: string; status?: number };
type CreateMessageResultDecl =
  | { ok: true; text: string }
  | { ok: false; status?: number; error: string };

type CliInstallHintsDecl = {
  os: string;
  arch: string;
  commands: {
    native?: string;
    packageManager?: string;
    npm: string;
  };
  docsUrl: string;
};
type CliRetryResultDecl =
  | { found: true; path: string; version: string | null }
  | { found: false; searchedPaths: string[] };
type CliSetBinaryResultDecl =
  | { ok: true; version: string | null }
  | { ok: false; error: string };

type PrPreflightErrorDecl = {
  code: 'no-cwd' | 'not-git' | 'no-gh' | 'on-default-branch' | 'dirty-tree' | 'no-commits';
  detail: string;
  branch?: string;
};
type PrPreflightResultDecl =
  | {
      ok: true;
      branch: string;
      base: string;
      availableBases: string[];
      repoRoot: string;
      suggestedTitle: string;
      suggestedBody: string;
    }
  | { ok: false; errors: PrPreflightErrorDecl[] };
type PrCreateResultDecl =
  | { ok: true; url: string; number: number }
  | { ok: false; error: string };
type PrCheckDecl = {
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
};
type PrChecksResultDecl =
  | { ok: true; checks: PrCheckDecl[] }
  | { ok: false; error: string };

declare global {
  interface Window {
    agentory?: {
      loadState: (key: string) => Promise<string | null>;
      saveState: (key: string, value: string) => Promise<void>;
      loadMessages: (sessionId: string) => Promise<unknown[]>;
      saveMessages: (sessionId: string, blocks: Array<{ id: string; kind: string }>) => Promise<void>;
      getVersion: () => Promise<string>;
      pickDirectory: () => Promise<string | null>;

      agentStart: (sessionId: string, opts: StartOpts) => Promise<StartResult>;
      agentSend: (sessionId: string, text: string) => Promise<boolean>;
      agentSendContent: (sessionId: string, content: unknown[]) => Promise<boolean>;
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
        Array<{ sessionId: string; cwd: string; title: string; mtime: number; projectDir: string; model: string | null }>
      >;

      /**
       * Most-recently-used cwds derived from CLI transcripts. Cached in main
       * via an eager scan at app `ready`, so this resolves quickly even on
       * first call after window load. Empty array if the scan is still in
       * flight or no transcripts are present.
       */
      recentCwds: () => Promise<string[]>;

      /**
       * Most-frequently-used model across recent CLI transcripts. Seeds the
       * new-session model default on fresh userData. Null if undeterminable.
       */
      topModel: () => Promise<string | null>;

      /**
       * Best-effort batched existence check. Returns a map keyed by the
       * input path; permission errors and ENOENT both map to `false`.
       * Used by the renderer's hydration migration to flag sessions whose
       * persisted `cwd` was deleted between runs.
       */
      pathsExist: (paths: string[]) => Promise<Record<string, boolean>>;

      memory: {
        read: (p: string) => Promise<
          | { ok: true; content: string; exists: boolean }
          | { ok: false; error: string }
        >;
        write: (p: string, content: string) => Promise<
          { ok: true } | { ok: false; error: string }
        >;
        exists: (p: string) => Promise<boolean>;
        userPath: () => Promise<string>;
        projectPath: (cwd: string) => Promise<string | null>;
      };

      pr: {
        preflight: (cwd: string | null | undefined) => Promise<PrPreflightResultDecl>;
        create: (args: {
          cwd: string;
          branch: string;
          base: string;
          title: string;
          body: string;
          draft: boolean;
        }) => Promise<PrCreateResultDecl>;
        checks: (cwd: string, number: number) => Promise<PrChecksResultDecl>;
      };

      openExternal: (url: string) => Promise<boolean>;

      notify: (payload: {
        sessionId: string;
        title: string;
        body?: string;
        eventType?: 'permission' | 'question' | 'turn_done' | 'test';
        silent?: boolean;
      }) => Promise<boolean>;
      onNotificationFocus: (handler: (sessionId: string) => void) => () => void;

      updatesStatus: () => Promise<UpdateStatus>;
      updatesCheck: () => Promise<UpdateStatus>;
      updatesDownload: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesInstall: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesGetAutoCheck: () => Promise<boolean>;
      updatesSetAutoCheck: (enabled: boolean) => Promise<boolean>;
      onUpdateStatus: (handler: (s: UpdateStatus) => void) => () => void;
      onUpdateAvailable: (
        handler: (info: { version: string; releaseDate?: string }) => void
      ) => () => void;
      onUpdateDownloaded: (handler: (info: { version: string }) => void) => () => void;
      onUpdateError: (handler: (info: { message: string }) => void) => () => void;

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
          patch: {
            name?: string;
            baseUrl?: string;
            apiKey?: string | null;
            isDefault?: boolean;
            kind?: EndpointKindDecl;
          }
        ) => Promise<EndpointRowDecl | null>;
        remove: (id: string) => Promise<boolean>;
        testConnection: (args: { baseUrl: string; apiKey: string }) => Promise<TestConnectionResultDecl>;
        refreshModels: (id: string) => Promise<RefreshResultDecl>;
        setManualModels: (id: string, ids: string[]) => Promise<EndpointRowDecl | null>;
        createMessage: (args: {
          endpointId: string;
          model: string;
          maxTokens?: number;
          messages: Array<{ role: 'user' | 'assistant'; content: string }>;
          system?: string;
        }) => Promise<CreateMessageResultDecl>;
      };

      models: {
        listByEndpoint: (id: string) => Promise<ModelRowDecl[]>;
        listAll: () => Promise<EndpointWithModelsDecl[]>;
      };

      cli: {
        getInstallHints: () => Promise<CliInstallHintsDecl>;
        browseBinary: () => Promise<string | null>;
        setBinaryPath: (p: string) => Promise<CliSetBinaryResultDecl>;
        openDocs: () => Promise<boolean>;
        retryDetect: () => Promise<CliRetryResultDecl>;
      };
    };
  }
}

export {};
