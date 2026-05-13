/**
 * R-46 audit-P0 (Task #158, F-T-1/2/3): structured JSON logger for the
 * cf-worker.
 *
 * Why: production observability needs machine-parseable lines so we can
 * pivot on level / event / request_id / login in CF dashboard log search.
 * Unstructured `console.log('[worker] route ...')` strings cannot be
 * filtered or aggregated.
 *
 * Wire format (one line per call, single-line JSON):
 *   {"ts":"2026-05-10T03:24:59.123Z","level":"info","event":"oauth.callback_ok",
 *    "request_id":"...","login":"...","sub_prefix":"abcd1234","fields":{...}}
 *
 * Level → console method:
 *   debug → console.debug, info → console.log, warn → console.warn,
 *   error → console.error.
 *
 * Redaction (F-T-3): `sanitizeFields` strips known-sensitive keys before
 * serialization so callers cannot accidentally leak access_token /
 * refresh_token / cookie body / JWT body even if a future patch hands the
 * raw object to `logger.info(...)`. The denylist intentionally covers
 * substrings (e.g. any key containing `token` is dropped) — callers who
 * legitimately need a token surface must pre-truncate (e.g.
 * `token_prefix`, `jti`).
 *
 * Forensics tags (`[r28]`, `[r31]`, `[r38]`) were retired in R-47
 * (Task #162). Their structured replacements live alongside this logger
 * (e.g. `do.proxy_http.*`, `worker.proxy_done`, daemon `daemon.http_req.*`).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Substring denylist — any field key containing one of these (case-insensitive)
 * is dropped before serialization. Callers wanting to surface a token must
 * pre-truncate and use a name that does NOT match (e.g. `token_prefix`).
 */
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

/** Truncate a sub (user_id, uuid since R-51a) to the first 8 chars for log surfacing.
 *  Pairs with logger calls that want to attribute an event to a user without
 *  printing the full id. */
export function shortSub(sub: string | undefined | null): string {
  if (typeof sub !== 'string' || sub.length === 0) return '-';
  return sub.slice(0, 8);
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
  /** Override for the sink — defaults to console.log/warn/error/debug. */
  sink?: (level: LogLevel, line: string) => void;
  /** Override for `Date.now()` — used by tests to lock timestamps. */
  clock?: () => number;
  /** Bound request_id propagated to every log record. */
  requestId?: string;
}

function defaultSink(level: LogLevel, line: string): void {
  // CF Workers route stdout/stderr by console method, so route warn/error
  // to the matching method to preserve severity routing.
  switch (level) {
    case 'debug':
      console.debug(line);
      return;
    case 'warn':
      console.warn(line);
      return;
    case 'error':
      console.error(line);
      return;
    default:
      console.log(line);
  }
}

export class Logger {
  private readonly minPriority: number;
  private readonly sink: (level: LogLevel, line: string) => void;
  private readonly clock: () => number;
  private readonly requestId?: string;

  constructor(opts: LoggerOptions = {}) {
    this.minPriority = LEVEL_PRIORITY[opts.minLevel ?? 'info'];
    this.sink = opts.sink ?? defaultSink;
    this.clock = opts.clock ?? Date.now;
    if (opts.requestId !== undefined) this.requestId = opts.requestId;
  }

  /** Return a new Logger with a request_id bound to every record. */
  child(requestId: string): Logger {
    return new Logger({
      minLevel: priorityToLevel(this.minPriority),
      sink: this.sink,
      clock: this.clock,
      requestId,
    });
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

/** Module-default logger for callers that don't need a child. Uses
 *  `info` minLevel and the default console sink. */
export const rootLogger = new Logger();

/**
 * Generate a request_id. Prefer cf-ray (Cloudflare's per-request edge id) so
 * we can correlate worker logs with CF analytics; fall back to a fresh
 * uuid when cf-ray is missing (e.g. local wrangler dev, vitest).
 */
export function deriveRequestId(req: Request): string {
  const cfRay = req.headers.get('cf-ray');
  if (cfRay && cfRay.length > 0) return cfRay;
  return crypto.randomUUID();
}
