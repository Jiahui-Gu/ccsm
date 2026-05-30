// Main-process structured logger.
//
// Replaces the legacy console-only stub. Owns:
//   * the electron-log file transport (10MB × 10 = 100MB cap, JSONL format,
//     per-file header with version/platform metadata)
//   * the IPC sink that catches renderer logs (electron-log's built-in
//     `ipc` transport — wired by `log.initialize()` in main.ts)
//   * runtime log-level changes (`setLevel` persisted via sqlite app_state)
//   * `CCSM_LOG_LEVEL` / `CCSM_LOG_ENABLE_FILE` env overrides
//
// FILE SINK DEFAULT: the file transport is gated on `app.isPackaged === false`
// (i.e. dev runs `npm run dev` get full JSONL on disk automatically) OR an
// explicit opt-in via `CCSM_LOG_ENABLE_FILE=1`. In packaged production builds
// with no env opt-in, the file transport is silenced (`elog.transports.file
// .level = false`) and the renderer-mirror file ring is skipped. Production
// users don't want diagnostic JSONL accumulating on disk for sessions they
// never asked to record; only the developer (dogfooding) needs it. Console +
// Sentry sinks are unchanged — console is free in production (no attached
// terminal) and Sentry init is governed separately.
//   * a tiny ring file for renderer-local fallback at
//     `app.getPath('userData')/renderer-logs/` (1MB × 2 = 2MB) — written by
//     the renderer's electron-log instance through the IPC bridge if main
//     is responsive, AND captured locally so a mid-crash renderer still
//     has tail evidence on disk
//
// TEST / CI SAFETY: this module is `import`-ed by ~80 call sites across the
// main bundle, including modules that vitest loads under plain Node (with
// no electron binary installed — the CI lint+typecheck+test job does NOT
// download the electron binary; only the e2e job does). `electron-log/main`
// does `require('electron')` at module-eval time, which throws "Electron
// failed to install correctly" when the binary stub returns no path. To
// keep vitest under Node from blowing up the moment ANY ptyHost / commands-
// loader test pulls in `entryFactory.ts → '../shared/log'`, all electron-
// dependent loads are deferred behind `isElectronRuntime()` (see
// `logRuntime.ts`):
//   * `require('electron-log/main')` — lazy, inside `getElog()`
//   * `require('electron')` for `app.getVersion()` / `app.getPath()` —
//     lazy, inside `getApp()`
// Outside Electron, every function in this module falls back to a console-
// only path. The renderer side (`src/shared/log.ts`) uses a parallel
// short-circuit keyed on `VITEST`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scrub, normalizeError, setHomeDir, EVENT_ALLOWED_FIELDS, scrubConsoleArgs } from '../../src/shared/scrub';
import { getApp, getElog, type LogLevel } from './logRuntime';
import { LOG_SCHEMA_VERSION, readEnvFlags, loadPersistedLevel, persistLevel, type EnvFlags } from './logState';
import { ensureHeader, jsonlFormat } from './logFormat';
import { archiveMainLog, archiveRendererLog } from './logRotation';

// Setting homedir for the path scrubber. Must happen before any record is
// emitted; called eagerly at module load so the first uncaughtException
// during bootstrap is scrubbed too. `os.homedir()` is a pure Node API — no
// electron dep — so it's safe to run at module-eval even on CI vitest.
try {
  setHomeDir(os.homedir());
} catch {
  // homedir unavailable in some sandboxed test envs — scrub falls back to
  // regex-only path handling.
}

// 100MB cap per process (10MB × 10 rotated files) per design v2 §1.
const MAIN_LOG_MAX_BYTES = 10 * 1024 * 1024;
// Renderer-local ring is much smaller — it's a fallback for the IPC bridge
// only, not the source of truth.
const RENDERER_LOG_MAX_BYTES = 1 * 1024 * 1024;

let _initialized = false;
let _currentLevel: LogLevel = 'info';

/** Module-level latch tracking whether the file sink actually got wired in
 *  `initLog()`. The menu builder reads this via `getLogFileEnabled()` to grey
 *  out the Reveal Logs / Set Log Level items in packaged builds with no opt-
 *  in — there are no log files to reveal and no file-level to change. */
let _fileSinkEnabled = false;

/** True iff the file transport is active (dev runtime, or production with
 *  `CCSM_LOG_ENABLE_FILE=1`). Called by `electron/lifecycle/appLifecycle.ts`
 *  to gate the Help submenu items. Returns false before `initLog()` runs. */
export function getLogFileEnabled(): boolean {
  return _fileSinkEnabled;
}

/** Decide whether to wire the file sink. Dev (unpackaged) always gets it;
 *  packaged builds need explicit opt-in via `CCSM_LOG_ENABLE_FILE=1`. If we
 *  can't even resolve `app.isPackaged` (e.g. mid-vitest with the electron
 *  binary stubbed), default to disabled — vitest doesn't need on-disk JSONL
 *  and the IPC + Sentry sinks already gracefully no-op. */
function shouldEnableFileSink(env: EnvFlags): boolean {
  if (env.enableFile) return true;
  const a = getApp();
  // `app.isPackaged === false` is dev runtime; true (or unresolvable) is
  // packaged. We explicitly check `=== false` rather than `!a.isPackaged`
  // so the unresolvable case (null app, undefined isPackaged) defaults to
  // disabled — safer for tests + paranoid prod fallback.
  return a?.isPackaged === false;
}

/** Configure electron-log transports. Idempotent — re-calling is a no-op.
 *  Under non-Electron runtime (vitest on plain Node, CI without binary),
 *  this is a no-op past the level read — every subsequent `log.*` call
 *  falls back to the console-only path. */
export function initLog(): void {
  if (_initialized) return;
  _initialized = true;

  const env = readEnvFlags();
  const persisted = loadPersistedLevel();
  _currentLevel = env.level ?? persisted ?? 'info';

  const elog = getElog();
  if (!elog) {
    // Non-Electron runtime — no transports to configure. The `emit()`
    // path below will see `elog === null` and route to console.
    return;
  }

  // Initialize the IPC bridge so renderer logs flow into main's transports.
  // Per electron-log v5: `initialize()` registers the IPC handlers.
  try {
    elog.initialize();
  } catch {
    // initialize() can throw in test envs where `ipcMain` is mocked. The
    // file + console transports still work; renderer-shipped records are
    // the only loss.
  }

  // Console transport: minimal one-liner. JSONL is hostile to terminal eyes,
  // so for the console we keep the existing `[tag] msg` shape readable.
  // electron-log's `format` returns `any[]` — return a 1-element array so
  // the downstream `toString` transform prints it verbatim.
  elog.transports.console.level = _currentLevel;
  elog.transports.console.format = (m) => {
    const first = m.data[0];
    if (typeof first === 'string' && first.startsWith('{')) {
      try {
        const p = JSON.parse(first) as Record<string, unknown>;
        const tag = p.tag ?? p.event ?? '';
        const msg = p.msg ?? '';
        return [`[${m.level}] ${tag ? `[${String(tag)}] ` : ''}${String(msg)}`];
      } catch {
        /* fall through */
      }
    }
    return [`[${m.level}] ${m.data.map((d) => String(d)).join(' ')}`];
  };

  // File transport. Gated on dev-runtime (`app.isPackaged === false`) OR
  // explicit `CCSM_LOG_ENABLE_FILE=1` opt-in. Packaged builds with no opt-in
  // silence the file transport entirely — no rotation, no header, no on-disk
  // JSONL. The IPC bridge for renderer records stays wired (it's cheap) but
  // electron-log silently drops records routed to a level=false transport.
  _fileSinkEnabled = shouldEnableFileSink(env);
  if (!_fileSinkEnabled) {
    elog.transports.file.level = false;
  } else {
    elog.transports.file.level = _currentLevel;
    elog.transports.file.format = jsonlFormat;
    elog.transports.file.maxSize = MAIN_LOG_MAX_BYTES;
    // `archiveLogFn` runs synchronously when the current file hits maxSize.
    // Default behavior renames `main.log` → `main.old.log`; electron-log v5
    // only keeps ONE rotated archive by default. For 10-file rotation we
    // override to cycle through `main.1.log` … `main.10.log`.
    elog.transports.file.archiveLogFn = archiveMainLog;

    // Header-on-new-file. electron-log resolves the file path lazily via
    // `transports.file.resolvePathFn`; capture it on first write.
    const resolvePath = elog.transports.file.resolvePathFn;
    if (resolvePath) {
      elog.transports.file.resolvePathFn = (vars: unknown, message?: unknown) => {
        const p = resolvePath(vars, message);
        ensureHeader(p, _currentLevel);
        return p;
      };
    }
  }

  // Renderer-local fallback transport: a small file at
  // `userData/renderer-logs/renderer.log`. The renderer's electron-log
  // instance ships records over IPC to main (handled by `transports.ipc`);
  // we ALSO want a local file so a mid-crash renderer still has tail
  // evidence if the IPC bridge has died. This transport on the MAIN side
  // captures the IPC-shipped renderer records into a separate file.
  //
  // Follows the same dev-vs-packaged gate as the primary file transport —
  // production users without `CCSM_LOG_ENABLE_FILE=1` get no on-disk JSONL
  // anywhere.
  if (_fileSinkEnabled) try {
    const userData = getApp()?.getPath?.('userData');
    if (!userData) throw new Error('userData unavailable');
    const rendererLogDir = path.join(userData, 'renderer-logs');
    if (!fs.existsSync(rendererLogDir)) {
      fs.mkdirSync(rendererLogDir, { recursive: true });
    }
    // Use the secondary scoped logger so renderer records land in a
    // separate file from main records (cleaner triage when one process
    // misbehaves but the other is fine).
    const rendererLogger = elog.create({ logId: 'renderer-mirror' });
    rendererLogger.transports.file.fileName = 'renderer.log';
    rendererLogger.transports.file.resolvePathFn = () =>
      path.join(rendererLogDir, 'renderer.log');
    rendererLogger.transports.file.maxSize = RENDERER_LOG_MAX_BYTES;
    rendererLogger.transports.file.format = jsonlFormat;
    rendererLogger.transports.console.level = false;
    // 2-file ring (1MB × 2 = 2MB cap per design v2).
    rendererLogger.transports.file.archiveLogFn = archiveRendererLog;
  } catch {
    // userData unavailable (tests) — renderer-mirror disabled, IPC still
    // routes renderer records into main's primary transports.
  }
}

/** Runtime log-level change. Applies to console + file transports. Persists
 *  via sqlite app_state so the choice survives restart. */
export function setLogLevel(level: LogLevel): void {
  _currentLevel = level;
  const elog = getElog();
  if (elog) {
    elog.transports.console.level = level;
    if (elog.transports.file.level !== false) {
      elog.transports.file.level = level;
    }
  }
  persistLevel(level);
}

/** Re-read the persisted log level from sqlite and apply it, IF the user
 *  has not pinned a value via `CCSM_LOG_LEVEL`. Call this exactly once,
 *  right after `initDb()` lands — `initLog()` runs before `app.whenReady()`
 *  (so db isn't open yet) and would otherwise fall through to the `info`
 *  default; the Help → Set Log Level radio would then boot showing the
 *  wrong checkmark until the user clicked once. Cold review finding #3c /
 *  #9. Returns `true` if the level actually changed (caller can rebuild
 *  the app menu so the radio reflects reality). */
export function syncPersistedLevelFromDb(): boolean {
  // Env override wins — respect the operator's explicit choice.
  if (readEnvFlags().level) return false;
  const persisted = loadPersistedLevel();
  if (!persisted || persisted === _currentLevel) return false;
  // Apply to transports + module state. Skip `persistLevel` — the value
  // already came from the db, no write-back needed (would be a no-op
  // anyway, but the avoidance keeps boot off the disk).
  _currentLevel = persisted;
  const elog = getElog();
  if (elog) {
    elog.transports.console.level = persisted;
    if (elog.transports.file.level !== false) {
      elog.transports.file.level = persisted;
    }
  }
  return true;
}

export function getLogLevel(): LogLevel {
  return _currentLevel;
}

export function getLogFilePath(): string {
  const elog = getElog();
  if (!elog?.transports.file.getFile) return '';
  try {
    return elog.transports.file.getFile().path;
  } catch {
    return '';
  }
}

type Tag = string;
type Msg = string;
type Fields = Record<string, unknown> | undefined;

function scrubFields(fields: Fields): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  return scrub(fields) as Record<string, unknown> | undefined;
}

function normalizeErrorFields(fields: Fields): Fields {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) out[k] = normalizeError(v);
    else out[k] = v;
  }
  return out;
}

function emit(
  level: 'debug' | 'info' | 'warn' | 'error',
  tag: Tag,
  msg: Msg,
  fields?: Fields,
): void {
  if (!_initialized) initLog();
  const payload = scrubFields(normalizeErrorFields(fields));
  const record = {
    schemaV: LOG_SCHEMA_VERSION,
    tag,
    msg,
    ...(payload ?? {}),
  };
  const json = JSON.stringify(record);
  const elog = getElog();
  if (elog) {
    elog[level](json);
  }
  // No console fallback on the structured path — the back-compat shims
  // below echo to console for the legacy `(tag, msg, ...rest)` callers.
  // Under non-Electron runtime, structured records simply drop (test
  // env doesn't need them, and the legacy callers still get console).
}

function compactRest(rest: unknown[]): Fields {
  if (rest.length === 0) return undefined;
  if (rest.length === 1) {
    const r = rest[0];
    if (r instanceof Error) return { error: normalizeError(r) };
    if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>;
    return { detail: r };
  }
  return { detail: rest };
}

export const log = {
  debug(tag: Tag, msg: Msg, fields?: Fields): void {
    emit('debug', tag, msg, fields);
  },
  info(tag: Tag, msg: Msg, fields?: Fields): void {
    emit('info', tag, msg, fields);
  },
  warn(tag: Tag, msg: Msg, fields?: Fields): void {
    emit('warn', tag, msg, fields);
  },
  error(tag: Tag, msg: Msg, fieldsOrErr?: Fields | Error): void {
    if (fieldsOrErr instanceof Error) {
      emit('error', tag, msg, { error: normalizeError(fieldsOrErr) });
      return;
    }
    emit('error', tag, msg, fieldsOrErr);
  },
  /** Structured probe. Unknown top-level keys in `fields` trigger a dev-only
   *  console warn (never throws in prod). */
  event(name: string, fields?: Fields): void {
    if (fields && process.env.NODE_ENV !== 'production') {
      for (const k of Object.keys(fields)) {
        if (!EVENT_ALLOWED_FIELDS.has(k)) {
          console.warn(
            `[log.event] unknown field '${k}' in event '${name}' — add to EVENT_ALLOWED_FIELDS or rename`,
          );
        }
      }
    }
    if (!_initialized) initLog();
    const payload = scrubFields(fields);
    const record = {
      schemaV: LOG_SCHEMA_VERSION,
      event: name,
      ...(payload ?? {}),
    };
    const json = JSON.stringify(record);
    const elog = getElog();
    if (elog) elog.info(json);
  },
};

// Back-compat shims preserved verbatim from the legacy stub.
//
// These ALSO call `console.warn` / `console.error` directly (matching the
// original stub's observable behavior). Reason: electron-log's node console
// transport captures `console.warn` / `console.error` references at module-
// load time, so a later `vi.spyOn(console, 'warn')` does not intercept
// records routed solely through electron-log. ~80 call sites + their tests
// already assert `console.warn` was called with `[tag] msg`; preserving the
// direct call keeps every legacy test contract intact while structured
// records flow to the file + IPC sinks via `log.warn` / `log.error`. The
// modern `log.event` / `log.debug` / `log.info` paths do NOT echo to
// console — only the back-compat shims do.
//
// SECURITY: `rest` is scrubbed BEFORE it reaches console — Errors get
// normalized (stack frames lose absolute paths), plain objects get the same
// forbidden-field drops + path/env scrubbing the structured sink uses.
// Without this, a caller doing `warn('foo','bad', err)` would print a raw
// `C:\Users\<name>\…` stack to dev stderr while the file sink stays clean
// — a transparent-transport violation flagged by cold review finding #1c.
export function warn(tag: string, msg: string, ...rest: unknown[]): void {
  console.warn(`[${tag}] ${msg}`, ...scrubConsoleArgs(rest));
  log.warn(tag, msg, compactRest(rest));
}
export function error(tag: string, msg: string, ...rest: unknown[]): void {
  console.error(`[${tag}] ${msg}`, ...scrubConsoleArgs(rest));
  if (rest.length === 1 && rest[0] instanceof Error) {
    log.error(tag, msg, rest[0]);
    return;
  }
  log.error(tag, msg, compactRest(rest));
}

// Re-export normalizeError for callers (main.ts uncaughtException etc.).
export { normalizeError };
