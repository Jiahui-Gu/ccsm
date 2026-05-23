// Shared PII / secret scrubber + error normalizer.
//
// Used by both main and renderer log transports. Per the transparent-transport
// memo, we MUST NOT log byte content of clipboard, IME composition strings,
// pty stdout, pty stdin, or env values. The scrubber is the last line of
// defense for that contract: any field that smells like content is dropped
// entirely, any field with a path/secret-shaped string is rewritten.
//
// Design notes:
//  * `electron/` tsconfig includes `src/shared/**/*` so this single file is
//    consumed by both the main bundle (commonjs) and the renderer bundle
//    (webpack). Keep it dependency-free: no `electron`, no `node:fs`, no
//    DOM. `os.homedir()` is read lazily via a setter — the renderer can pass
//    its own value (or omit it).
//  * Recursion is depth-limited (default 4). Beyond that depth the value is
//    replaced with `'[depth-limit]'` rather than throwing — logging must
//    never crash the host.

// Env-var key regexes (v2 §3 + design doc step 2 expansion).
const ENV_KEY_PREFIX = /^(ANTHROPIC_|CLAUDE_|AWS_)/i;
const ENV_KEY_SUFFIX =
  /(_ID|_PASS|_URI|_URL|_CREDENTIALS|TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)$/i;

// Connection-string detector. Order matters only for readability — any match
// short-circuits.
const CONN_STRING_RES: readonly RegExp[] = [
  /^mongodb(\+srv)?:\/\//i,
  /^postgres(ql)?:\/\//i,
  /^mysql:\/\//i,
  /^redis:\/\//i,
  // userinfo-bearing http(s) URL — matches `https://user:pw@host/...`
  /^https?:\/\/[^/\s@]+@/i,
];

// Path detector. Catches Windows drive paths, UNC `\\?\C:\…`, WSL `/mnt/c/…`,
// POSIX home/system dirs. Applied as a global replace inside any string field
// AND inside `Error.stack` (stack frames have paths embedded mid-line).
const PATH_RE =
  /([A-Za-z]:\\|\\\\\?\\[A-Za-z]:\\|\\\\[^\s'"\\]+\\|\/Users\/|\/home\/|\/mnt\/[a-z]\/|\/root\/|\/var\/|\/tmp\/)[^\s'"]*/g;

// Forbidden field names — dropped entirely from any object before serialization.
// `name` covers session names; `message` is dropped because user-supplied
// content commonly lands there (ad-hoc `{message: '...'}`). Error.message is
// re-injected via `normalizeError` *after* scrub, so the legitimate error
// path still works.
const FORBIDDEN_FIELDS = new Set<string>([
  'content',
  'data',
  'buffer',
  'text',
  'clipboard',
  'composition',
  'name',
  'env',
  'body',
  'payload',
  'raw',
  'input',
  'output',
  'stdin',
  'stdout',
  'stderr',
  'args',
  'argv',
  'cmdline',
  'command',
  'query',
  'params',
  'headers',
  'cookies',
  'authorization',
  'message',
  'url',
  'title',
  'value',
  'prompt',
  'arg',
  'cmd',
]);

// Allowlist of metadata keys legal at `log.event(...)` payload level. Unknown
// keys at the top level of an event payload trigger a dev-only assertion (see
// log.ts). NOT used to drop fields at runtime — the scrubber's forbidden-list
// + path/secret regexes already cover the leak surface.
export const EVENT_ALLOWED_FIELDS = new Set<string>([
  'sid',
  'bytes',
  'durationMs',
  'cols',
  'rows',
  'viewportY',
  'viewportYBefore',
  'viewportYAfter',
  'baseY',
  'from',
  'to',
  'reason',
  'stage',
  'callsite',
  'count',
  'chunks',
  'bracketed',
  'crlfFound',
  'ptyResized',
  // Additional fields used by attach probes and `term.firstWrite.afterAttach`.
  'msSinceAttach',
  'durationMsSinceAttach',
  'kind',
  'bufferedChunks',
  'bufferedBytes',
  'bytesBefore',
  'bytesAfter',
  'updateCount',
  'elapsedMs',
]);

const DEFAULT_DEPTH = 4;
const REDACTED = '[redacted]';
const CONN_STRING = '[connection-string]';
const PATH_TOKEN = '[path]';

// Home-dir prefix replacement. `os.homedir()` resolution is lazy + injectable:
// node-side calls `setHomeDir(os.homedir())` once at boot; renderer calls
// `setHomeDir(window.process?.env?.HOME ?? null)` (usually null in sandbox).
let _homeDir: string | null = null;
export function setHomeDir(dir: string | null): void {
  _homeDir = dir && dir.length > 0 ? dir : null;
}
export function getHomeDir(): string | null {
  return _homeDir;
}

function scrubString(s: string): string {
  if (!s) return s;
  // Connection-string first: a Postgres URL is also "path-like" (contains
  // slashes) and we don't want a partial scrub.
  for (const re of CONN_STRING_RES) {
    if (re.test(s)) return CONN_STRING;
  }
  let out = s;
  // Home-dir prefix → `~`. Must run BEFORE the path regex, otherwise the
  // path regex would replace the whole path with `[path]` and we'd lose the
  // information that the path was rooted in homedir vs. /tmp.
  if (_homeDir && out.includes(_homeDir)) {
    // Use split/join to avoid regex-escaping the homedir (which can contain
    // backslashes on Windows that would be interpreted as regex escapes).
    out = out.split(_homeDir).join('~');
  }
  // Path-like substrings → `[path]`. Global replace handles multiple matches
  // per line (common in stack traces).
  out = out.replace(PATH_RE, PATH_TOKEN);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function shouldRedactEnvKey(key: string): boolean {
  return ENV_KEY_PREFIX.test(key) || ENV_KEY_SUFFIX.test(key);
}

/**
 * Recursive scrubber. Returns a NEW value — never mutates input. Handles:
 *   * strings: connection-string detection → path/homedir rewrite.
 *   * objects: drops forbidden keys, redacts env-shaped keys, recurses on
 *     remaining values (depth-limited).
 *   * arrays: recursed elementwise.
 *   * everything else: passthrough.
 */
export function scrub(value: unknown, depth: number = DEFAULT_DEPTH): unknown {
  if (depth <= 0) return '[depth-limit]';
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth - 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_FIELDS.has(k)) continue; // drop entirely
      if (shouldRedactEnvKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = scrub(v, depth - 1);
    }
    return out;
  }
  // Non-plain object (class instance etc.) — fall back to string form so we
  // never accidentally serialize a `Buffer.toJSON()` or similar.
  try {
    return scrubString(String(value));
  } catch {
    return '[unserializable]';
  }
}

/** Normalize an Error for JSON-safe logging. Both `message` and `stack` are
 *  scrubbed (stack frames are where `C:\Users\<username>\…` leaks happen
 *  most). `cause` chains are walked recursively.
 *
 *  IMPORTANT: the `name` field here intentionally bypasses the forbidden-
 *  fields drop. Error class names (`TypeError`, `RangeError`, custom subclass
 *  names like `ClaudeSpawnError`) are NOT PII — they're structural metadata
 *  needed to triage logs. The forbidden list catches `name` to block session
 *  names (which are user-supplied free text); error class names live on a
 *  separate axis and are safe to keep. */
export function normalizeError(e: unknown): {
  name: string;
  message: string;
  stack: string;
  cause?: ReturnType<typeof normalizeError>;
} {
  if (!(e instanceof Error)) {
    return { name: 'NonError', message: scrubString(String(e)), stack: '' };
  }
  return {
    name: e.name,
    message: scrubString(e.message ?? ''),
    stack: scrubString(e.stack ?? ''),
    cause:
      (e as Error & { cause?: unknown }).cause != null
        ? normalizeError((e as Error & { cause?: unknown }).cause)
        : undefined,
  };
}
