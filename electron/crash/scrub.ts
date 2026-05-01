// electron/crash/scrub.ts
import * as os from 'node:os';

const ALLOW = /^(NODE_ENV|CCSM_.*|ELECTRON_.*)$/;

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
