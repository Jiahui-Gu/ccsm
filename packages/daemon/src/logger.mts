/**
 * R-47 audit-P0 (Task #162, F-Q-1 + F-T-7): structured JSON logger for the
 * daemon. Mirrors `packages/cf-worker/src/logger.ts` (R-46) so worker + DO +
 * daemon emit comparable line shapes — operators can pivot on the same
 * `event` / `request_id` / `level` keys across the whole tunnel path.
 *
 * Why a separate file (and not a shared util in @ccsm/shared):
 *   - cf-worker logger writes to `console.*` which CF Workers route to
 *     stdout/stderr by method; daemon must write to `process.stderr`
 *     directly so JSON lines never collide with PTY data on stdout.
 *   - daemon needs Node-only `process.env` gating (env-driven debug toggles
 *     for legacy R-39 hello-trace). cf-worker has no equivalent surface.
 *   - The worker logger is shipped as part of the worker bundle (no Node
 *     primitives allowed); duplicating ~120 LOC is cheaper than wedging
 *     conditional environment detection into a shared module.
 *
 * Wire format (one line per call, single-line JSON, written to stderr):
 *   {"ts":"2026-05-10T03:24:59.123Z","level":"info","event":"daemon.http_req",
 *    "request_id":"...","fields":{...}}
 *
 * Redaction (F-T-3 parity): `sanitizeFields` strips known-sensitive keys
 * before serialization so callers cannot accidentally leak access_token /
 * refresh_token / cookie / JWT body even if a future patch hands a raw
 * object to `logger.info(...)`.
 */

import process from 'node:process';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Substring denylist — any field key containing one of these (case-insensitive)
 * is dropped before serialization. Callers wanting to surface a token must
 * pre-truncate and use a name that does NOT match (e.g. `token_prefix`). */
const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'authorization',
  'set-cookie',
  'jwt',
  'access_token',
  'refresh_token',
  'client_secret',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  for (const needle of SENSITIVE_KEY_SUBSTRINGS) {
    if (k.includes(needle)) return true;
  }
  return false;
}

export type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | LogValue[]
  | { [k: string]: LogValue };

export interface LogFields {
  [key: string]: LogValue;
}

/** Strip sensitive keys from a fields object recursively. Returns a fresh
 *  object so the caller's input is not mutated. */
export function sanitizeFields(fields: LogFields | undefined): LogFields {
  if (fields === undefined || fields === null) return {};
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (isSensitiveKey(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeFields(v as LogFields);
    } else {
      out[k] = v as LogValue;
    }
  }
  return out;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  request_id?: string;
  fields?: LogFields;
}

export interface LoggerOptions {
  /** Minimum level emitted; lower-priority records are dropped. */
  minLevel?: LogLevel;
  /** Override sink — defaults to writing one line + '\n' to process.stderr. */
  sink?: (level: LogLevel, line: string) => void;
  /** Override clock — used by tests to lock timestamps. */
  clock?: () => number;
  /** Bound request_id propagated to every log record. */
  requestId?: string;
}

function defaultSink(_level: LogLevel, line: string): void {
  // stderr keeps log lines off PTY stdout. Using `write` (vs console.error)
  // avoids the inspector formatting layer so the JSON line is byte-faithful.
  process.stderr.write(line + '\n');
}

/**
 * Resolve the minimum log level. Order of precedence:
 *   1. explicit `opts.minLevel`
 *   2. `process.env.CCSM_DEBUG_R39 === '1'` → `debug` (legacy R-39 hello /
 *      tunnel-rx narrative log surface; defaulted off so production stays quiet)
 *   3. `process.env.CCSM_LOG_LEVEL` if it names a valid level
 *   4. fall back to `info`
 *
 * Read fresh on every Logger construction so tests / runtime tweaks via
 * `process.env` take effect without re-import.
 */
function resolveMinLevel(opts: LoggerOptions): LogLevel {
  if (opts.minLevel !== undefined) return opts.minLevel;
  if (process.env.CCSM_DEBUG_R39 === '1') return 'debug';
  const envLvl = process.env.CCSM_LOG_LEVEL;
  if (
    envLvl === 'debug' ||
    envLvl === 'info' ||
    envLvl === 'warn' ||
    envLvl === 'error'
  ) {
    return envLvl;
  }
  return 'info';
}

export class Logger {
  private readonly minPriority: number;
  private readonly sink: (level: LogLevel, line: string) => void;
  private readonly clock: () => number;
  private readonly requestId?: string;

  constructor(opts: LoggerOptions = {}) {
    this.minPriority = LEVEL_PRIORITY[resolveMinLevel(opts)];
    this.sink = opts.sink ?? defaultSink;
    this.clock = opts.clock ?? Date.now;
    if (opts.requestId !== undefined) this.requestId = opts.requestId;
  }

  /** Return a new Logger with a request_id bound to every record. */
  child(requestId: string): Logger {
    const opts: LoggerOptions = {
      minLevel: priorityToLevel(this.minPriority),
      sink: this.sink,
      clock: this.clock,
      requestId,
    };
    return new Logger(opts);
  }

  debug(event: string, fields?: LogFields): void {
    this.emit('debug', event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.emit('error', event, fields);
  }

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_PRIORITY[level] < this.minPriority) return;
    const sanitized = sanitizeFields(fields);
    const rec: LogRecord = {
      ts: new Date(this.clock()).toISOString(),
      level,
      event,
    };
    if (this.requestId !== undefined) rec.request_id = this.requestId;
    if (Object.keys(sanitized).length > 0) rec.fields = sanitized;
    let line: string;
    try {
      line = JSON.stringify(rec);
    } catch {
      // Fallback if a field is non-serializable (BigInt, circular, etc.).
      const fb: LogRecord = {
        ts: rec.ts,
        level: 'error',
        event: 'logger.serialize_failed',
        fields: { original_event: event },
      };
      if (rec.request_id !== undefined) fb.request_id = rec.request_id;
      line = JSON.stringify(fb);
    }
    this.sink(level, line);
  }
}

function priorityToLevel(p: number): LogLevel {
  if (p <= LEVEL_PRIORITY.debug) return 'debug';
  if (p <= LEVEL_PRIORITY.info) return 'info';
  if (p <= LEVEL_PRIORITY.warn) return 'warn';
  return 'error';
}

/** Module-default logger for callers that don't need a child. Construction-
 *  time env reads control the level — if a test wants a different level, build
 *  a fresh Logger with explicit `opts.minLevel`. */
export const rootLogger = new Logger();
