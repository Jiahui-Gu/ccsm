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
  // Build-time constant injected by webpack DefinePlugin (see
  // `webpack.config.js`). Sourced from `package.json#version`. Used by
  // static version-display surfaces (Settings → Updates) after Wave 0b
  // purged the `window.ccsm.getVersion` IPC bridge.
  const __APP_VERSION__: string;

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
      getVersion?: () => Promise<string>;

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

      updatesStatus: () => Promise<UpdateStatus>;
      updatesCheck: () => Promise<UpdateStatus>;
      updatesDownload: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesInstall: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      updatesGetAutoCheck: () => Promise<boolean>;
      updatesSetAutoCheck: (enabled: boolean) => Promise<boolean>;
      onUpdateStatus: (handler: (s: UpdateStatus) => void) => () => void;
      onUpdateDownloaded: (handler: (info: { version: string }) => void) => () => void;
    };
  }
}

export {};
