import type { CliPermissionMode } from './agent/permission';
import type { ClaudeStreamEvent } from '../electron/agent/stream-json-types';
import type {
  ConnectionInfo,
  OpenSettingsResult,
  DiscoveredModel,
  CliInstallHints,
  CliRetryResult,
  CliSetBinaryResult,
  LoadedCommand,
} from './shared/ipc-types';

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
type AgentDiagnostic = {
  sessionId: string;
  level: 'warn' | 'error';
  code: string;
  message: string;
};
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
    ccsm?: {
      loadState: (key: string) => Promise<string | null>;
      saveState: (key: string, value: string) => Promise<void>;
      // i18n bridge mirrors the API surface exposed in electron/preload.ts.
      // `getSystemLocale` returns the OS locale so the renderer's
      // preferences store can resolve a "system" preference; `setLanguage`
      // pushes the resolved UI language back to main so OS notifications
      // come out in the matching language.
      i18n: {
        getSystemLocale: () => Promise<string | undefined>;
        setLanguage: (l: 'en' | 'zh') => void;
      };
      loadMessages: (sessionId: string) => Promise<unknown[]>;
      saveMessages: (
        sessionId: string,
        blocks: Array<{ id: string; kind: string }>
      ) => Promise<{ ok: true } | { ok: false; error: string }>;
      getVersion: () => Promise<string>;
      pickDirectory: () => Promise<string | null>;
      saveFile: (args: {
        defaultName?: string;
        content: string;
      }) => Promise<
        { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
      >;

      agentStart: (sessionId: string, opts: StartOpts) => Promise<StartResult>;
      agentSend: (sessionId: string, text: string) => Promise<boolean>;
      agentSendContent: (sessionId: string, content: unknown[]) => Promise<boolean>;
      agentInterrupt: (sessionId: string) => Promise<boolean>;
      agentSetPermissionMode: (
        sessionId: string,
        mode: PermissionMode
      ) => Promise<{ ok: true } | { ok: false; error: string }>;
      agentSetModel: (sessionId: string, model?: string) => Promise<boolean>;
      agentClose: (sessionId: string) => Promise<boolean>;
      agentResolvePermission: (
        sessionId: string,
        requestId: string,
        decision: 'allow' | 'deny'
      ) => Promise<boolean>;
      onAgentEvent: (handler: (e: AgentEvent) => void) => () => void;
      onAgentExit: (handler: (e: AgentExit) => void) => () => void;
      onAgentDiagnostic: (handler: (e: AgentDiagnostic) => void) => () => void;
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
       * Read the raw frames of an importable `.jsonl` so the renderer can
       * project them through `streamEventToTranslation` and hydrate
       * `messagesBySession` immediately at import time. Returns [] on any
       * read error so the caller can fall back to the empty-chat behavior.
       */
      loadImportHistory: (projectDir: string, sessionId: string) => Promise<unknown[]>;

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
        list: (cwd: string | null | undefined) => Promise<LoadedCommand[]>;
      };

      openExternal: (url: string) => Promise<boolean>;

      notify: (payload: {
        sessionId: string;
        title: string;
        body?: string;
        eventType?: 'permission' | 'question' | 'turn_done' | 'test';
        silent?: boolean;
      }) => Promise<boolean>;
      notifyAvailability: () => Promise<{ available: boolean; error: string | null }>;
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
        onBeforeHide: (handler: (info: { durationMs: number }) => void) => () => void;
        onAfterShow: (handler: () => void) => () => void;
        platform: 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';
      };

      connection: {
        read: () => Promise<ConnectionInfo>;
        openSettingsFile: () => Promise<OpenSettingsResult>;
      };

      models: {
        list: () => Promise<DiscoveredModel[]>;
      };

      cli: {
        getInstallHints: () => Promise<CliInstallHints>;
        browseBinary: () => Promise<string | null>;
        setBinaryPath: (p: string) => Promise<CliSetBinaryResult>;
        openDocs: () => Promise<boolean>;
        retryDetect: () => Promise<CliRetryResult>;
      };
    };
  }
}

export {};
