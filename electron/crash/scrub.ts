// electron/crash/scrub.ts
//
// Crash-time secret/PII scrubbing. Used by:
//   - electron/crash/collector.ts before writing error.json + stderr/stdout-tail
//   - electron/ipc/rendererErrorForwarder.ts via collector for renderer crashes
//
// The daemon ships its own copy of redactSecrets() at daemon/src/crash/scrub.ts
// (deliberate duplication — daemon is a separate process / build target and we
// do NOT cross-import between electron/ and daemon/src/). Keep the two lists in
// sync; if you change one, change the other and add a UT in both suites.
//
// Source of truth for the redact list: docs/superpowers/specs/v0.3-fragments/
// frag-6-7-reliability-security.md §6.6.3 + §6.6 secret-redaction list.
import * as os from 'node:os';

// CCSM_DAEMON_SECRET intentionally excluded — it carries the daemon HMAC
// secret and must never appear in crash dumps. Keep this list narrow; any
// new CCSM_* var carrying a secret MUST be omitted explicitly here too.
const ALLOW = /^(NODE_ENV|CCSM_(?!DAEMON_SECRET\b).*|ELECTRON_.*)$/;

export function scrubHomePath(s: string): string {
  const home = os.homedir();
  if (!s || !home) return s;
  // Replace longest match first; both raw and backslash-escaped variants.
  return s.split(home).join('~');
}

export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v != null && ALLOW.test(k)) out[k] = v;
  }
  return out;
}

// ---- Secret redaction (frag-6-7 §6.6 + §6.6.3) -----------------------------

const REDACTED = '<REDACTED>';

// Object property names whose value must always be redacted, case-insensitive.
// Matches both exact names and any property whose name ENDS WITH ".secret" or
// ".apiKey" (e.g. obj.daemon.secret, obj.foo.apiKey).
const SECRET_KEY_NAMES = new Set<string>([
  'apikey',
  'token',
  'authorization',
  'cookie',
  'anthropic_api_key',
  'daemonsecret',
  'installsecret',
  'pingsecret',
  'hellononce',
  'clienthellononce',
  'hellononcehmac',
  'secret',
]);

function isSecretKey(key: string): boolean {
  const lk = key.toLowerCase();
  if (SECRET_KEY_NAMES.has(lk)) return true;
  // suffix matches for "*.secret" / "*.apiKey" style nested keys flattened
  // to a single property name (e.g. "daemon.secret" used as key).
  if (lk.endsWith('.secret') || lk.endsWith('.apikey')) return true;
  // Also catch ALL_CAPS env-shaped keys ending in _SECRET / _TOKEN / _API_KEY.
  if (/_(SECRET|TOKEN|API_KEY)$/i.test(key)) return true;
  return false;
}

// String-level patterns: stack traces / log lines / stderr tails arrive as
// strings, so we have to scrub by regex too.
//
// Patterns (each replaced with `<NAME>: <REDACTED>` or `<KEY>=<REDACTED>`):
//   1. HTTP-ish header lines:  Authorization: Bearer xxx   |   Cookie: foo=bar
//   2. env-style assignments:  ANTHROPIC_API_KEY=sk-xxx    |   FOO_TOKEN=xxx
//   3. JSON-ish quoted props:  "daemonSecret":"xxx"        |   "token": "xxx"
const HEADER_RE = /\b(Authorization|Cookie|Proxy-Authorization|X-Api-Key)(\s*[:=]\s*)([^\r\n,;]+)/gi;
const ENV_RE = /\b((?:ANTHROPIC_API_KEY|[A-Z][A-Z0-9_]*_(?:SECRET|TOKEN|API_KEY)|daemonSecret|installSecret|pingSecret|helloNonce|clientHelloNonce|helloNonceHmac))=([^\s'"]+)/g;
const JSON_PROP_RE = /"(apiKey|token|authorization|cookie|ANTHROPIC_API_KEY|daemonSecret|installSecret|pingSecret|helloNonce|clientHelloNonce|helloNonceHmac|secret)"(\s*:\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/gi;

function redactString(s: string): string {
  if (!s) return s;
  return s
    .replace(HEADER_RE, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(ENV_RE, (_m, name: string) => `${name}=${REDACTED}`)
    .replace(JSON_PROP_RE, (_m, name: string, sep: string) => `"${name}"${sep}"${REDACTED}"`);
}

/**
 * Recursively redact secrets from a string or JSON-shaped value.
 *
 * - Strings are scanned for header/env/JSON-property patterns.
 * - Objects: any property whose name matches the secret key set has its value
 *   replaced with `<REDACTED>` regardless of type. Other properties are
 *   recursed into.
 * - Arrays are recursed element-wise.
 * - Other primitives (number, boolean, null, undefined) pass through unchanged.
 *
 * Cycles are guarded with a visited set; cycle nodes are replaced with the
 * string `[Circular]` so we never crash a crash-handler.
 */
export function redactSecrets<T>(input: T): T {
  const seen = new WeakSet<object>();
  function walk(v: unknown): unknown {
    if (typeof v === 'string') return redactString(v);
    if (v == null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(vv);
      }
    }
    return out;
  }
  return walk(input) as T;
}
