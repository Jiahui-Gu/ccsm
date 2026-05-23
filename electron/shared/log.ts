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
// dependent loads are deferred behind `isElectronRuntime()`:
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

// Tighter LogLevel — electron-log's own includes `verbose | silly` which we
// don't expose at the API layer. The four CCSM levels map straight onto
// electron-log's homonymous methods.
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Minimal subset of the electron-log surface we use, so the non-Electron
// fallback can implement just these. Avoids declaring `any` while still
// keeping the unknown shape opaque to callers.
type ElogLike = {
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

const LOG_SCHEMA_VERSION = 1;
const LOG_LEVEL_KEY = 'ccsm.logLevel';

// 100MB cap per process (10MB × 10 rotated files) per design v2 §1.
const MAIN_LOG_MAX_BYTES = 10 * 1024 * 1024;
// Renderer-local ring is much smaller — it's a fallback for the IPC bridge
// only, not the source of truth.
const RENDERER_LOG_MAX_BYTES = 1 * 1024 * 1024;

let _initialized = false;
let _currentLevel: LogLevel = 'info';
let _elog: ElogLike | null = null;

/** True when running under Electron (main process with the binary live).
 *  vitest under plain Node has `process.versions.electron === undefined`,
 *  so this returns false and every electron-dependent path falls back to
 *  console-only / no-op. Cheaper than env probing; immune to e2e runs that
 *  forget to set NODE_ENV / VITEST. */
function isElectronRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.electron === 'string';
}

/** Lazily resolve `electron-log/main`. Returns null outside Electron so
 *  callers can fall back to console-only without crashing on the
 *  `require('electron')` inside electron-log's own boot. */
function getElog(): ElogLike | null {
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
function getApp(): {
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

type EnvFlags = {
  level: LogLevel | null;
  enableFile: boolean;
};

function readEnvFlags(): EnvFlags {
  const raw = process.env.CCSM_LOG_LEVEL?.toLowerCase();
  const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const level = raw && (valid as string[]).includes(raw) ? (raw as LogLevel) : null;
  const enableFile = process.env.CCSM_LOG_ENABLE_FILE === '1';
  return { level, enableFile };
}

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

/** Reads persisted log level from sqlite app_state. Imported lazily to avoid
 *  a circular dep (db.ts imports nothing from log.ts but the boot order has
 *  this module loaded before db init). Falls back to `info`. */
function loadPersistedLevel(): LogLevel | null {
  try {
    // Lazy require — db init happens later in app.whenReady; before that
    // call this returns null and the boot uses the env override or 'info'.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require('../db') as typeof import('../db');
    const raw = db.loadState(LOG_LEVEL_KEY);
    if (raw && ['debug', 'info', 'warn', 'error'].includes(raw)) {
      return raw as LogLevel;
    }
  } catch {
    // db not initialized yet — fall through.
  }
  return null;
}

function persistLevel(level: LogLevel): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const db = require('../db') as typeof import('../db');
    db.saveState(LOG_LEVEL_KEY, level);
  } catch {
    // db not ready — runtime change still applies in-memory; next boot
    // re-derives from env / default.
  }
}

/** Per-file header written as the FIRST line of every new (or rotated) log
 *  file. Makes attached logs self-describing — no need to ask the user
 *  "what version were you on". */
function buildHeader(): string {
  let appVersion = 'unknown';
  try {
    appVersion = getApp()?.getVersion?.() ?? 'unknown';
  } catch {
    /* app not ready in tests */
  }
  return (
    JSON.stringify({
      schemaV: LOG_SCHEMA_VERSION,
      app: 'ccsm',
      version: appVersion,
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      os: process.platform,
      arch: process.arch,
      level: _currentLevel,
      sessionStart: new Date().toISOString(),
    }) + os.EOL
  );
}

/** Write the header to the live file if it's empty (fresh boot or
 *  immediately post-rotation). electron-log's `archiveLog` hook fires AFTER
 *  the rotation; this function is idempotent so calling it on every record
 *  costs at most one stat call (handled by the size check). */
function ensureHeader(filePath: string): void {
  try {
    const st = fs.statSync(filePath);
    if (st.size === 0) {
      fs.writeFileSync(filePath, buildHeader(), { flag: 'a' });
    }
  } catch {
    // file does not yet exist — electron-log will create it on first write
    // and we'll header it on the next call. No-op here.
  }
}

/** electron-log message formatter → JSONL. electron-log's transform chain
 *  treats `format` as `(params: FormatParams) => any[]`; we return a
 *  1-element array containing the JSONL string and the downstream `toString`
 *  transform serializes it as-is. We accept already-structured payloads from
 *  our `log.api.emit()` in `data[0]` and augment with timestamp/level;
 *  ad-hoc string args are wrapped. */
function jsonlFormat(params: {
  data: unknown[];
  level: string;
  message: { date: Date };
}): unknown[] {
  const first = params.data[0];
  let payload: Record<string, unknown>;
  // Convention: every `emit()` / `log.event` call site stringifies a single
  // JSON object and passes it as `data[0]` (see `emit()` below — it always
  // calls `elog[level](JSON.stringify(record))` with no trailing newline and
  // no second arg). The `{…}` shape check is a fast structural filter that
  // distinguishes our structured records from ad-hoc string args (e.g.
  // direct `elog.warn('plain text')` from third-party paths). Any payload
  // that matches `{…}` is parse-and-merged; everything else is wrapped as
  // `{msg: ...}`. The `JSON.parse` is inside a try/catch so a stray `{json-
  // shaped} string` doesn't crash the transport.
  if (typeof first === 'string' && first.startsWith('{') && first.endsWith('}')) {
    try {
      payload = JSON.parse(first) as Record<string, unknown>;
    } catch {
      payload = { msg: first };
    }
  } else {
    payload = { msg: params.data.map((d) => String(d)).join(' ') };
  }
  const record = {
    t: params.message.date.toISOString(),
    level: params.level,
    pid: process.pid,
    ...payload,
  };
  return [JSON.stringify(record)];
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
    elog.transports.file.archiveLogFn = (oldLog) => {
      const file = String(oldLog);
      const dir = path.dirname(file);
      const base = path.basename(file, '.log');
      // Shift main.9.log → main.10.log, main.8.log → main.9.log, …
      try {
        for (let i = 9; i >= 1; i--) {
          const from = path.join(dir, `${base}.${i}.log`);
          const to = path.join(dir, `${base}.${i + 1}.log`);
          if (fs.existsSync(from)) {
            if (i + 1 > 10) {
              fs.unlinkSync(from);
            } else {
              fs.renameSync(from, to);
            }
          }
        }
        const renamed = path.join(dir, `${base}.1.log`);
        fs.renameSync(file, renamed);
      } catch (e) {
        // Best-effort: if rotation fails (locked file on Windows etc.) we
        // emit a console.error but keep logging — the live file is the
        // bigger concern than the archive chain.
        console.error('[log] rotation failed:', e);
      }
    };

    // Header-on-new-file. electron-log resolves the file path lazily via
    // `transports.file.resolvePathFn`; capture it on first write.
    const resolvePath = elog.transports.file.resolvePathFn;
    if (resolvePath) {
      elog.transports.file.resolvePathFn = (vars: unknown, message?: unknown) => {
        const p = resolvePath(vars, message);
        ensureHeader(p);
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
    rendererLogger.transports.file.archiveLogFn = (oldLog) => {
      const file = String(oldLog);
      const dir = path.dirname(file);
      const base = path.basename(file, '.log');
      try {
        const archive = path.join(dir, `${base}.1.log`);
        if (fs.existsSync(archive)) fs.unlinkSync(archive);
        fs.renameSync(file, archive);
      } catch {
        /* best-effort */
      }
    };
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
