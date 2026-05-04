// packages/daemon/test/integration/bundle/no-jwt-in-v03.spec.ts
//
// T8.12 — integration spec: assert the v0.3 daemon bundle pipeline carries
// no JWT validator implementation.
//
// Spec ch12 §3:
//   "bundle/no-jwt-in-v03.spec.ts — guard against v0.4 listener-b leakage:
//    the v0.3 daemon SEA bundle MUST NOT contain `jwtValidator` /
//    `verifyJwt` symbols. Stands in for the absent listener-b.ts module
//    until v0.4 lands the real implementation."
//
// Spec ch03 §1 / ch03 §5 / ch05 §2:
//   v0.3 has exactly one auth chain link (peer-cred). The v0.4-only JWT
//   validator interceptor is out-of-scope; any bundled symbol with that
//   name would be a leakage of v0.4 work into the v0.3 ship.
//
// Strategy choice (a / b / c, see Task #96 spec):
//
//   We pick (b) — grep the daemon source tree (`packages/daemon/src/**`)
//   plus the SEA bundle pipeline metadata (`build/sea-config.json`,
//   `build/build-sea.{sh,ps1}`). Rationale:
//
//   - (a) "spec self-builds the SEA binary then greps it" is correct but
//     minutes-slow on every CI run; v0.3 ship-gate already has a sea
//     smoke job that builds the binary downstream. Putting build:sea on
//     every vitest invocation is the wrong layer.
//   - (c) "wire build:sea into ci.yml then grep the produced binary" is
//     the right v0.4 answer (the spec author flags this as the future
//     direction), but it requires modifying the workflow + assumes a
//     binary exists at spec-run time, which it currently does not on the
//     working tip (verifier confirmed 2026-05-04).
//   - (b) is forward-safe: source-grep catches every realistic leakage
//     vector for v0.3 — esbuild bundles `dist/index.js`'s import closure
//     (which is `packages/daemon/src/**` after tsc), so any new module
//     introducing `jwtValidator` / `verifyJwt` identifiers would have to
//     live under `src/**`. Transitive deps cannot smuggle the symbol in
//     because (i) v0.3 has zero JWT libraries in `package.json`, (ii)
//     esbuild externalizes native modules, (iii) any new dep that adds
//     such a symbol would have to be added by a PR a reviewer can catch.
//
//   When v0.4 wires the real SEA build into CI, swap this for a binary
//   grep against the produced `dist/ccsm-daemon` (strategy (c)).
//
// Comment-aware: the existing `src/auth/interceptor.ts` mentions
// "jwtValidatorInterceptor" in a doc comment describing the v0.4 chain
// shape (lines 27-30, "v0.4's JWT validator will be a second
// interceptor..."). That is *intentional* spec documentation, not
// leakage — the comment exists precisely to pin the v0.4 plan without
// implementing it. We strip line + block comments before scanning so
// the prose-as-design-doc convention does not falsely trip the guard.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// __dirname = packages/daemon/test/integration/bundle
// repoRoot   = ../../../../.. (5 levels up)
const PKG_DAEMON_DIR = join(HERE, '..', '..', '..');
const SRC_DIR = join(PKG_DAEMON_DIR, 'src');
const BUILD_DIR = join(PKG_DAEMON_DIR, 'build');

/** Tokens we forbid in the v0.3 bundle source closure. */
const FORBIDDEN_TOKENS = ['jwtValidator', 'verifyJwt'] as const;

/**
 * Recursively collect files under `dir` whose extension is in `exts`.
 * Skips `node_modules` and `dist` (build outputs that mirror src).
 */
async function collectFiles(dir: string, exts: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectFiles(full, exts)));
    } else if (ent.isFile() && exts.some((e) => ent.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments from a TS/JS
 * source file. Conservative: does not try to be string-literal aware;
 * a forbidden token inside a string literal would still trip the guard,
 * which is the correct behavior (a stringly-typed `'jwtValidator'` flag
 * embedded in code IS leakage we want to catch).
 */
function stripComments(src: string): string {
  // Remove block comments first (greedy across lines).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove single-line comments. Anchor to start of line OR after whitespace
  // to avoid eating `://` inside URLs that appear in code (e.g. import
  // specifiers with protocol prefixes — unlikely in TS, but cheap to be
  // safe). We accept that `const u = "https://..."` keeps `//...` in the
  // string; that is fine because string-literal identifiers ARE leakage.
  out = out.replace(/^\s*\/\/.*$/gm, '');
  out = out.replace(/(\s)\/\/.*$/gm, '$1');
  return out;
}

/** Find forbidden tokens in `text`. Returns matched tokens (deduped). */
function findForbidden(text: string): string[] {
  const hits = new Set<string>();
  for (const token of FORBIDDEN_TOKENS) {
    if (text.includes(token)) hits.add(token);
  }
  return [...hits];
}

describe('bundle/no-jwt-in-v03 (ch12 §3 — v0.4 listener-b leakage guard)', () => {
  it('packages/daemon/src/**/*.ts contains no `jwtValidator` / `verifyJwt` outside comments', async () => {
    const files = await collectFiles(SRC_DIR, ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
    expect(files.length).toBeGreaterThan(0);

    const offenders: { file: string; tokens: string[] }[] = [];
    for (const file of files) {
      const raw = await readFile(file, 'utf8');
      const stripped = stripComments(raw);
      const hits = findForbidden(stripped);
      if (hits.length > 0) {
        offenders.push({ file: relative(PKG_DAEMON_DIR, file), tokens: hits });
      }
    }

    expect(
      offenders,
      `v0.4 JWT validator leakage detected in v0.3 bundle source closure:\n` +
        offenders.map((o) => `  - ${o.file}: ${o.tokens.join(', ')}`).join('\n') +
        `\n(These tokens belong to v0.4 listener-b; see ch03 §1 / ch05 §2.)`,
    ).toEqual([]);
  });

  it('packages/daemon/build/sea-config.json contains no `jwtValidator` / `verifyJwt`', async () => {
    // sea-config.json drives `node --experimental-sea-config`; any
    // hand-edited entry point or extra resource that named a JWT validator
    // module would surface here.
    const cfg = await readFile(join(BUILD_DIR, 'sea-config.json'), 'utf8');
    const hits = findForbidden(cfg);
    expect(hits, `sea-config.json must not reference v0.4 JWT validator: ${hits.join(', ')}`).toEqual([]);
  });

  it('packages/daemon/build/build-sea.{sh,ps1} contain no `jwtValidator` / `verifyJwt`', async () => {
    // The bundle pipeline scripts MUST NOT bake JWT validation into the
    // SEA build (e.g., as an extra esbuild entry, a postject resource, or
    // an embedded literal). Comment-stripping is intentionally NOT applied
    // here — shell/PS1 scripts referencing the symbol in ANY form
    // (including comments) would be a planning leak we want to surface.
    for (const name of ['build-sea.sh', 'build-sea.ps1']) {
      const text = await readFile(join(BUILD_DIR, name), 'utf8');
      const hits = findForbidden(text);
      expect(hits, `${name} must not reference v0.4 JWT validator: ${hits.join(', ')}`).toEqual([]);
    }
  });
});
