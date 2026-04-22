import type { CliPermissionMode } from './agent/permission';
import type { ClaudeStreamEvent } from '../electron/agent/stream-json-types';

type PermissionMode = CliPermissionMode;
type AgentMessage = ClaudeStreamEvent;

type StartOpts = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
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

type ModelSourceDecl =
  | 'settings'
  | 'env'
  | 'manual'
  | 'cli-picker'
  | 'env-override'
  | 'fallback';
type DiscoveredModelDecl = { id: string; source: ModelSourceDecl };
type ConnectionInfoDecl = {
  baseUrl: string | null;
  model: string | null;
  hasAuthToken: boolean;
};
type OpenSettingsResultDecl = { ok: true } | { ok: false; error: string };

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

type CommandSourceDecl = 'user' | 'project' | 'plugin';
type LoadedCommandDecl = {
  name: string;
  description?: string;
  argumentHint?: string;
  source: CommandSourceDecl;
  pluginId?: string;
};

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

      commands: {
        list: (cwd: string | null | undefined) => Promise<LoadedCommandDecl[]>;
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

      connection: {
        read: () => Promise<ConnectionInfoDecl>;
        openSettingsFile: () => Promise<OpenSettingsResultDecl>;
      };

      models: {
        list: () => Promise<DiscoveredModelDecl[]>;
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
