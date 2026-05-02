// daemon/src/crash/scrub.ts
//
// Daemon-side mirror of electron/crash/scrub.ts redactSecrets().
//
// We deliberately DO NOT cross-import between daemon/ and electron/. Daemon is
// a separate build target / process. Keep the redact list + regex patterns in
// sync with electron/crash/scrub.ts; if you change one, change the other and
// add a UT in both suites. Source of truth: docs/superpowers/specs/
// v0.3-fragments/frag-6-7-reliability-security.md §6.6 + §6.6.3.

const REDACTED = '<REDACTED>';

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
  if (lk.endsWith('.secret') || lk.endsWith('.apikey')) return true;
  if (/_(SECRET|TOKEN|API_KEY)$/i.test(key)) return true;
  return false;
}

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
