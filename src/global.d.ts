// Updater status — exported so the renderer's `UpdatesPane` (and any
// future banners/toasts) can import a single source of truth instead of
// redeclaring the union locally. Mirrors the shape broadcast by
// `electron/updater.ts` over the `updates:status` IPC channel.
export type UpdateStatus =
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
      // pushes the resolved UI language back to main for any future
      // OS-level surfaces (tray menu, future notifications) to consume.
      i18n: {
        getSystemLocale: () => Promise<string | undefined>;
        setLanguage: (l: 'en' | 'zh') => void;
      };
      getVersion: () => Promise<string>;

      scanImportable: () => Promise<
        Array<{ sessionId: string; cwd: string; title: string; mtime: number; projectDir: string; model: string | null }>
      >;

      /**
       * Most-recently-used cwds for the StatusBar cwd popover. Sourced from
       * the ccsm-owned LRU (NOT CLI JSONL scans). Never empty: returns
       * `[homedir()]` when the user hasn't picked anything yet.
       */
      recentCwds: () => Promise<string[]>;

      /**
       * `os.homedir()` from the main process. Seeds the always-true default
       * cwd for new sessions (replaces the old recent-history-derived
       * default). Resolved once at boot and cached in the renderer store.
       */
      userHome: () => Promise<string>;

      /**
       * ccsm-owned LRU of cwds explicitly chosen by the user. Lives in the
       * `app_state` SQLite table; capped at 20 entries. Push returns the
       * post-update list so callers can update local UI without a round-trip.
       */
      userCwds: {
        get: () => Promise<string[]>;
        push: (p: string) => Promise<string[]>;
      };

      /**
       * Open the OS folder picker for the cwd popover's "Browse..." button.
       * Returns the picked absolute path on success, or `null` when the
       * user cancelled. Backs the popover Browse action (#628).
       */
      pickCwd: (defaultPath?: string) => Promise<string | null>;

      /**
       * Default model from `~/.claude/settings.json`'s `model` field — the
       * same value the CLI consults for `--model` defaulting. Seeds the
       * new-session picker. Null when unset, missing, or unparseable.
       */
      defaultModel: () => Promise<string | null>;

      /**
       * Best-effort batched existence check. Returns a map keyed by the
       * input path; permission errors and ENOENT both map to `false`.
       * Used by the renderer's hydration migration to flag sessions whose
       * persisted `cwd` was deleted between runs.
       */
      pathsExist: (paths: string[]) => Promise<Record<string, boolean>>;

      /**
       * Open an external URL in the user's default browser via the main
       * process's `shell.openExternal`. The IPC handler enforces a strict
       * http(s) scheme whitelist, so callers can pass arbitrary URIs
       * harvested from PTY output (xterm WebLinksAddon) without
       * pre-validating: anything non-http(s) resolves to `false` with no
       * side effect. Production caller: Ctrl/Cmd-click on a terminal link.
       */
      openExternal: (url: string) => Promise<boolean>;

      updatesStatus: () => Promise<UpdateStatus>;
      updatesCheck: () => Promise<UpdateStatus>;
      updatesDownload: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesInstall: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesGetAutoCheck: () => Promise<boolean>;
      updatesSetAutoCheck: (enabled: boolean) => Promise<boolean>;
      onUpdateStatus: (handler: (s: UpdateStatus) => void) => () => void;
      onUpdateDownloaded: (handler: (info: { version: string }) => void) => () => void;

      window: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<boolean>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        onMaximizedChanged: (handler: (max: boolean) => void) => () => void;
        onBeforeHide: (handler: (info: { durationMs: number }) => void) => () => void;
        onAfterShow: (handler: () => void) => () => void;
        onAskCloseAction: (
          handler: (payload: {
            requestId: string;
            labels: {
              message: string;
              detail: string;
              tray: string;
              quit: string;
              cancel: string;
              dontAskAgain: string;
            };
          }) => void
        ) => () => void;
        resolveCloseAction: (payload: {
          requestId: string;
          choice: 'tray' | 'quit' | 'cancel';
          dontAskAgain: boolean;
        }) => void;
        platform: 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';
      };

      /**
       * Renderer-readable feature-flag snapshot, captured once at preload
       * init from `process.env`. Static values — re-reads return the same
       * thing for the renderer's lifetime. Currently used by
       * `src/terminal/*` to select the warm-xterm path (#25).
       */
      featureFlags: {
        /** `CCSM_WARM_XTERM === '1'` — per-session warm Terminal cache. */
        warmXterm: boolean;
        /**
         * `CCSM_WARM_XTERM_CAP` parsed as an integer, clamped to [2,100].
         * `null` when unset or unparseable; consumer falls back to its
         * own default (20).
         */
        warmXtermCap: number | null;
      };
    };
  }
}

export {};
