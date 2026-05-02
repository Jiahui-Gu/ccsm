// electron/log.ts
//
// Electron-main pino logger (v0.3 task #125, frag-12 §12.1, frag-6-7 §6.6.2).
//
// Structured logger for the Electron main process. Mirrors the daemon-side
// logger (see frag-6-7 §6.6.1 for the contract — daemon-side module is task
// #124) so cross-process log correlation works without a third tool.
//
// Contract:
//   - Base fields: { side: 'electron', v: APP_VERSION, pid, boot: bootNonce }
//     `side` is REQUIRED so log aggregation does not collide daemon and
//     electron lines that share `{v, pid, boot}` keys (r2-obs P0-1).
//   - Same `pino-roll` config as daemon: daily / 50MB / 7-file / symlink:true.
//     Files at `<dataRoot>/logs/electron/electron-YYYY-MM-DD.log` with stable
//     `electron.log` symlink → current rotated file.
//   - Redact list = daemon §6.6.1 superset PLUS renderer-leaning paths.
//   - `pino.final` analog on every Electron-main exit path
//     (`app.before-quit`, `process.on('uncaughtException')`,
//     `process.on('unhandledRejection')`) — see installCrashHooks().
//     pino v9 dropped the `pino.final` export, so the analog is a sync
//     `logger.flush()` after the fatal line is logged (mirrors daemon
//     task #124's choice).
//   - Renderer console-forward gated by CCSM_RENDERER_LOG_FORWARD=1
//     (default OFF in production; renderer code uses preload bridge to ship
//     console.* to main, main writes pino).
//
// This module is `add` not `replace` — existing console.* call sites keep
// working; new code SHOULD prefer the structured `logger` export.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from 'ulid';
import pino, { type Logger } from 'pino';
// pino-roll is loaded lazily via require() inside createLogger so that
// pure-import test paths (which only need redact / base-field assertions
// against an in-memory destination) don't have to install the transport.
import { resolveDataRoot, type DataRootProvider } from './crash/incident-dir';

/** Electron-main boot nonce. ULID per r2-obs OPEN-4. Generated at module
 *  load and re-exported so other electron-main modules (e.g. supervisor
 *  reconnect attempts that want to correlate with the spawning electron
 *  boot) can stamp it on outgoing envelopes. */
export const electronBootNonce: string = ulid();

/** Read the renderer-bundled / electron-main package version. main.ts and
 *  Sentry init both already import `app.getVersion()` lazily; we accept it
 *  as a constructor arg so this module stays import-safe before
 *  `app.whenReady()`. */
export interface LoggerOptions {
  appVersion: string;
  /** Override boot nonce for tests. */
  bootNonce?: string;
  /** Override data root (defaults to `resolveDataRoot()`). Tests pass a
   *  tmpdir; when this is set the pino-roll destination writes there. */
  dataRootProvider?: DataRootProvider;
  /** Override the directory where pino-roll writes log files. When unset,
   *  resolves to `<dataRoot>/logs/electron/` per frag-6-7 §6.6.2 (path
   *  layout matches daemon-side §6.6.1, with a per-side `electron/`
   *  subdirectory so daemon logs stay separate). */
  logDir?: string;
  /** Inject a destination for tests. When set, `pino-roll` is bypassed and
   *  the redact / base-field contract is asserted against the in-memory
   *  sink. */
  destination?: pino.DestinationStream;
  /** When true, skip pino-roll transport setup (used by tests + when
   *  `destination` is provided). */
  skipFileTransport?: boolean;
}

/**
 * Pino redact paths for electron-main. Mirrors daemon §6.6.1 redact list
 * (r2-sec P0-S1 + r3-lockin CF-3 + sec-S4) PLUS renderer-leaning paths
 * per frag-6-7 §6.6.2 (`*.url`, `*.searchParams`, `*.headers`,
 * `*.formData`).
 *
 * Task #125 minimum redact list (from task brief):
 *   `*.secret`, `*.password`, `*.token`, `daemon.secret`, `imposterSecret`,
 *   `authorization`.
 *
 * Spec §6.6.1/§6.6.2 superset:
 *   apiKey, Cookie, ANTHROPIC_API_KEY, payload.value, env.ANTHROPIC star,
 *   daemonSecret, installSecret, pingSecret, helloNonce, clientHelloNonce,
 *   helloNonceHmac, plus renderer-leaning url/searchParams/headers/formData.
 *
 * `Authorization` (HTTP capitalisation) appears alongside lowercase
 * `authorization` so both renderer-forwarded fetch headers and code-path
 * shapes get scrubbed.
 */
export const ELECTRON_REDACT_PATHS: readonly string[] = Object.freeze([
  // Task #125 minimum (per brief).
  '*.secret',
  '*.password',
  '*.token',
  'daemon.secret',
  'imposterSecret',
  'authorization',
  // Daemon §6.6.1 superset (mirror).
  '*.apiKey',
  'Authorization',
  'Cookie',
  'ANTHROPIC_API_KEY',
  '*.payload.value',
  'env.ANTHROPIC*',
  'daemonSecret',
  'installSecret',
  'pingSecret',
  'helloNonce',
  'clientHelloNonce',
  'helloNonceHmac',
  // §6.6.2 renderer-leaning superset.
  '*.url',
  '*.searchParams',
  '*.headers',
  '*.formData',
]);

/**
 * Censor string used for redacted values. Spec wording is `[Redacted]`
 * (frag-12 §12.1) — matches daemon-side `DAEMON_REDACT_CENSOR` (task #124,
 * `daemon/src/log/index.ts`) so cross-side log scrubbing is byte-identical.
 */
export const ELECTRON_REDACT_CENSOR = '[Redacted]';

/** Default electron log directory: `<dataRoot>/logs/electron/`. Per
 *  frag-6-7 §6.6.2 + §6.6 path table; per-side subdir keeps daemon and
 *  electron log files separate so the disk-cap watchdog can prune one
 *  side's history without disturbing the other. */
export function resolveElectronLogDir(provider?: DataRootProvider): string {
  return path.join(resolveDataRoot(provider), 'logs', 'electron');
}

function buildPinoRollTransport(logDir: string): pino.DestinationStream {
  fs.mkdirSync(logDir, { recursive: true });
  // Lazy-require: keeps the transport optional for environments that
  // don't ship pino-roll (e.g. fast unit tests that only assert base
  // fields / redact paths via an in-memory destination).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pinoRoll = require('pino-roll') as unknown as (opts: Record<string, unknown>) => pino.DestinationStream;
  // pino-roll API: returns a SonicBoom stream piped through the date /
  // size rotation policy. Same config as daemon §6.6.1: daily, 50 MB
  // per file, 7-file count, mkdir true, symlink true so `electron.log`
  // always points to the current rotated file (POSIX `tail -F` survives
  // the daily rotation, Windows tray entry per r3-devx P1-4 opens the
  // rotated file directly).
  // The cast keeps this self-contained when pino-roll's own types
  // disagree across minor versions.
  return pinoRoll({
    file: path.join(logDir, 'electron'),
    extension: '.log',
    frequency: 'daily',
    size: '50M',
    limit: { count: 7 },
    mkdir: true,
    symlink: true,
    dateFormat: 'yyyy-MM-dd',
  });
}

/**
 * Construct the electron-main pino logger. Pure: every effect (file
 * creation, env reads) is parameterised so tests can swap in an in-memory
 * destination + a tmp dataRoot.
 *
 * IMPORTANT: this function is the single construction point for the
 * exported `logger` singleton; do NOT rebuild a parallel logger elsewhere
 * in electron-main — `pino.final` semantics rely on the singleton.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const dest =
    opts.destination ??
    (opts.skipFileTransport
      ? undefined
      : buildPinoRollTransport(opts.logDir ?? resolveElectronLogDir(opts.dataRootProvider)));

  const baseConfig: pino.LoggerOptions = {
    base: {
      side: 'electron',
      v: opts.appVersion,
      pid: process.pid,
      boot: opts.bootNonce ?? electronBootNonce,
    },
    redact: {
      paths: [...ELECTRON_REDACT_PATHS],
      censor: ELECTRON_REDACT_CENSOR,
    },
    // Timestamps: pino default (epoch ms). Mirrors daemon §6.6.1 which
    // also uses the pino default — keeps cross-side correlation a single
    // numeric compare instead of needing ISO parsing on one side.
  };

  return dest ? pino(baseConfig, dest) : pino(baseConfig);
}

/**
 * Lazy singleton. We can't construct the logger at module-load time
 * because `app.getVersion()` is unavailable until `app.whenReady()` (and
 * because tests `vi.mock('electron', ...)` the entire module). Callers
 * that need an immediate logger can pass `appVersion` explicitly to
 * `getLogger({ appVersion })`; once initialised, all subsequent calls
 * return the same instance.
 */
let singleton: Logger | undefined;

export function getLogger(opts?: Partial<LoggerOptions>): Logger {
  if (singleton) return singleton;
  // Default to a no-file destination when no opts arrive, so the very
  // first import of this module (e.g. from test code) never tries to
  // touch `<dataRoot>/logs/electron/`. The first real call from main.ts
  // (with `appVersion`) replaces this seed.
  if (!opts || !opts.appVersion) {
    singleton = pino({
      base: {
        side: 'electron',
        v: '0.0.0',
        pid: process.pid,
        boot: electronBootNonce,
      },
      redact: { paths: [...ELECTRON_REDACT_PATHS], censor: ELECTRON_REDACT_CENSOR },
    });
    return singleton;
  }
  singleton = createLogger({ ...opts, appVersion: opts.appVersion });
  return singleton;
}

/** Replace the singleton (test-only seam). */
export function __setLoggerForTest(l: Logger | undefined): void {
  singleton = l;
}

/**
 * Install crash hooks against the Electron app + Node process. Mirrors
 * daemon §6.6.1: every observable exit path flushes pino so the most
 * diagnostic moment (the crash) is not lost from the Electron side
 * (r2-obs P0-4).
 *
 * pino.final note: the spec text references `pino.final`, but that helper
 * was removed in pino v7+ and is not exported by pino v9 (the version
 * pinned in package.json). The v9 idiom — and what daemon-side task #124
 * also uses — is to call `logger.flush()` synchronously inside the crash
 * handler. For pino-roll's SonicBoom-backed destination this drains the
 * buffer to disk before `process.exit()` returns; for the in-memory
 * destinations used by tests it's a no-op. Either way the crash line is
 * emitted before the flush call, so the line itself is durable as soon as
 * pino's sync write returns.
 *
 * Hooks installed:
 *   - `app.before-quit`           — graceful Cmd-Q / "Quit ccsm".
 *   - `process.on('uncaughtException')`  — escaped throw from any
 *     electron-main module that wireCrashHandlers didn't catch first.
 *   - `process.on('unhandledRejection')` — same for promises.
 *
 * Caller wires `app` separately so this module stays test-friendly
 * (vitest doesn't load electron). Pass `{ exitOnFatal: false }` from
 * tests so the assertion doesn't bring down the runner.
 */
export interface CrashHookApp {
  on(event: 'before-quit', handler: () => void): unknown;
}

export interface InstallCrashHooksOptions {
  /** When false (test default), uncaught/unhandledRejection do NOT call
   *  process.exit after the final flush — lets vitest assert the
   *  `logger.flush()` call without killing the runner. Production main.ts
   *  passes true (or omits) so the process actually exits. */
  exitOnFatal?: boolean;
  /** Override the logger (test injection). When unset, uses `getLogger()`. */
  logger?: Logger;
  /** Override the process to install handlers on (test injection). */
  processRef?: NodeJS.Process;
}

export function installCrashHooks(
  app: CrashHookApp,
  options: InstallCrashHooksOptions = {},
): void {
  const exitOnFatal = options.exitOnFatal ?? true;
  const logger = options.logger ?? getLogger();
  const proc = options.processRef ?? process;

  // before-quit: log + flush. App will then proceed through will-quit /
  // quit on its own; we don't process.exit here because that'd skip
  // electron's window-close choreography.
  app.on('before-quit', () => {
    try {
      logger.info({ event: 'electron_before_quit' }, 'electron_before_quit');
    } finally {
      try { logger.flush(); } catch { /* best-effort */ }
    }
  });

  // uncaughtException: log the fatal line, drain the destination, exit.
  // (pino.final equivalent for v9 — see installCrashHooks header.)
  proc.on('uncaughtException', (err: Error) => {
    try {
      logger.fatal({ err, event: 'electron_uncaught_exception' }, 'electron_uncaught_exception');
    } catch { /* logger itself may be torn down */ }
    try { logger.flush(); } catch { /* best-effort */ }
    if (exitOnFatal) {
      // Same exit code daemon/src/crash/handlers.ts uses for symmetry.
      proc.exit(70);
    }
  });

  // unhandledRejection: same final-flush semantics.
  proc.on('unhandledRejection', (reason: unknown) => {
    try {
      logger.fatal(
        { err: reason instanceof Error ? reason : new Error(String(reason)), event: 'electron_unhandled_rejection' },
        'electron_unhandled_rejection',
      );
    } catch { /* best-effort */ }
    try { logger.flush(); } catch { /* best-effort */ }
    if (exitOnFatal) proc.exit(70);
  });
}

/**
 * Renderer console-forward IPC channel name. Renderer's preload bridge
 * sends `{ level, args }` payloads through this channel; main subscribes
 * (gated by CCSM_RENDERER_LOG_FORWARD=1) and writes them via pino.
 *
 * Default OFF in production (per frag-6-7 §6.6.2 + task #125 brief — main
 * log must not be polluted by renderer noise unless explicitly enabled).
 */
export const RENDERER_LOG_FORWARD_CHANNEL = 'log:write';

/** Env var that gates renderer console-forward end-to-end. Both sides
 *  (preload AND main IPC subscriber) check this. */
export const RENDERER_LOG_FORWARD_ENV = 'CCSM_RENDERER_LOG_FORWARD';

export function isRendererLogForwardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RENDERER_LOG_FORWARD_ENV] === '1';
}

/** Levels accepted from the renderer (matches console.* shapes). */
export type RendererLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface RendererLogPayload {
  level: RendererLogLevel;
  args: unknown[];
}

/**
 * Install the IPC handler that accepts renderer console-forward writes
 * and routes them through the electron-main pino logger. No-op when the
 * env gate is off; safe to call unconditionally from main.ts boot.
 *
 * Sender provenance: we trust only the main-frame top-level frame (per
 * the project-wide `fromMainFrame` ipc guard pattern in
 * electron/security/ipcGuards.ts — see also rendererErrorForwarder.ts:139
 * for the canonical application). Non-main frames (iframes, future
 * <webview>) cannot inject log lines: a sub-frame sender is silently
 * dropped before the payload is parsed.
 */
export interface RendererLogIpcEvent {
  senderFrame?: unknown;
  sender?: { mainFrame?: unknown };
}

export interface RendererLogIpcMain {
  on(channel: string, handler: (event: RendererLogIpcEvent, payload: RendererLogPayload) => void): unknown;
}

/** Inline main-frame check — mirrors electron/security/ipcGuards.ts
 *  `fromMainFrame()` (which is typed for IpcMainInvokeEvent and so can't
 *  be reused directly against the `on()` event shape). Pure structural
 *  identity test: senderFrame must be the WebContents' mainFrame. */
function isFromMainFrame(e: RendererLogIpcEvent): boolean {
  return !!e && !!e.sender && e.senderFrame === e.sender.mainFrame;
}

export function installRendererLogForwarder(
  ipcMain: RendererLogIpcMain,
  options: { env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): boolean {
  if (!isRendererLogForwardEnabled(options.env)) return false;
  const logger = options.logger ?? getLogger();
  ipcMain.on(RENDERER_LOG_FORWARD_CHANNEL, (event, payload) => {
    // Sub-frame guard (per project ipcGuards pattern). Drop silently to
    // avoid giving a compromised iframe a feedback channel. Closes the
    // iframe-injection gap when CCSM_RENDERER_LOG_FORWARD=1.
    if (!isFromMainFrame(event)) return;
    if (!payload || typeof payload !== 'object') return;
    const lvl: RendererLogLevel = payload.level && ['trace', 'debug', 'info', 'warn', 'error'].includes(payload.level)
      ? payload.level
      : 'info';
    const args = Array.isArray(payload.args) ? payload.args : [];
    // Stringify each arg so renderer-side Error / object shapes don't
    // explode the redact paths (renderer-supplied keys are NOT in our
    // redact list by design; we treat the payload as opaque text).
    const msg = args.map((a) => {
      if (a instanceof Error) return a.stack ?? a.message;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    logger[lvl]({ event: 'renderer_console_forward', source: 'renderer' }, msg);
  });
  return true;
}

// Re-export the canonical singleton accessor under the name the spec
// uses ("logger") so call sites read like the daemon side: `logger.info`.
// This is a getter so consumers always see the latest singleton even if
// __setLoggerForTest swapped it.
export const logger: Logger = new Proxy({} as Logger, {
  get(_t, prop, receiver) {
    const target = getLogger() as unknown as Record<string | symbol, unknown>;
    const value = target[prop];
    if (typeof value === 'function') return (value as (...args: unknown[]) => unknown).bind(target);
    return Reflect.get(target, prop, receiver);
  },
});
