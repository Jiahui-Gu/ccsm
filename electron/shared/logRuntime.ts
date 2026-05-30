// Lazy Electron-runtime resolvers for the main-process logger.
//
// `electron-log/main` does `require('electron')` at module-eval time, which
// throws "Electron failed to install correctly" when the binary stub returns
// no path (CI vitest under plain Node). To keep vitest from blowing up the
// moment ANY module pulls in `../shared/log`, all electron-dependent loads are
// deferred behind `isElectronRuntime()`:
//   * `require('electron-log/main')` — lazy, inside `getElog()`
//   * `require('electron')` for `app.getVersion()` / `app.getPath()` —
//     lazy, inside `getApp()`
// Outside Electron, callers fall back to a console-only path.

// Tighter LogLevel — electron-log's own includes `verbose | silly` which we
// don't expose at the API layer. The four CCSM levels map straight onto
// electron-log's homonymous methods.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Minimal subset of the electron-log surface we use, so the non-Electron
// fallback can implement just these. Avoids declaring `any` while still
// keeping the unknown shape opaque to callers.
export type ElogLike = {
  initialize: () => void;
  transports: {
    console: { level: LogLevel | false; format?: (m: { data: unknown[]; level: string; message: { date: Date } }) => unknown[] };
    file: {
      level: LogLevel | false;
      fileName?: string;
      maxSize?: number;
      format?: (params: { data: unknown[]; level: string; message: { date: Date } }) => unknown[];
      archiveLogFn?: (oldLog: unknown) => void;
      resolvePathFn?: (vars: unknown, message?: unknown) => string;
      getFile?: () => { path: string };
    };
  };
  create: (opts: { logId: string }) => ElogLike;
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

let _elog: ElogLike | null = null;

/** True when running under Electron (main process with the binary live).
 *  vitest under plain Node has `process.versions.electron === undefined`,
 *  so this returns false and every electron-dependent path falls back to
 *  console-only / no-op. Cheaper than env probing; immune to e2e runs that
 *  forget to set NODE_ENV / VITEST. */
export function isElectronRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.electron === 'string';
}

/** Lazily resolve `electron-log/main`. Returns null outside Electron so
 *  callers can fall back to console-only without crashing on the
 *  `require('electron')` inside electron-log's own boot. */
export function getElog(): ElogLike | null {
  if (_elog) return _elog;
  if (!isElectronRuntime()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-log/main') as { default?: ElogLike } & ElogLike;
    _elog = (mod.default ?? mod) as ElogLike;
    return _elog;
  } catch {
    // electron-log threw on load (e.g. the binary path resolver hit a
    // corrupt install). Fall back to console-only; logging is best-effort.
    return null;
  }
}

/** Lazily resolve `electron.app`. Same rationale as `getElog`. Returns
 *  null outside Electron. */
export function getApp(): {
  getVersion?: () => string;
  getPath?: (name: string) => string;
  isPackaged?: boolean;
} | null {
  if (!isElectronRuntime()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      app?: {
        getVersion?: () => string;
        getPath?: (name: string) => string;
        isPackaged?: boolean;
      };
    };
    return electron.app ?? null;
  } catch {
    return null;
  }
}
