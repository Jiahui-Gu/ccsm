// packages/daemon/test/integration/daemon-sea-boot.spec.ts
//
// Task #463 — SEA-bundle boot regression gate.
//
// Goal: prove that the daemon's TypeScript sources do not contain any
// `fileURLToPath(import.meta.url)` (or equivalent) calls in the synchronous
// boot path. esbuild rewrites `import.meta` to a `{}` stub when bundling to
// CJS for the SEA carrier, so any such call would throw `TypeError: The
// "url" argument must be of type string. Received undefined` and crash the
// daemon at the corresponding phase before listener-a binds. The
// pre-Task-#463 daemon crashed at phase OPENING_DB with exactly this stack
// (dev #457 round-3, traced to `dist/bundle.cjs:6961` in the bundled
// migrations runner).
//
// Why this is a STATIC analysis instead of a spawn-the-exe runtime test:
//   * CI does not currently build the SEA binary (`build:sea:posix` /
//     `build:sea:win` are NOT in the default lint/build/test matrix — see
//     `.github/workflows/ci.yml` line 429-431; SEA build is owned by T9.x).
//     A runtime spec that only ran when `dist/ccsm-daemon{.exe}` existed
//     would silently no-op on every PR and miss the next regression.
//   * The crash is deterministic at bundle time — `import.meta.url` either
//     gets rewritten to `import_meta_N.url` by esbuild, or it does not.
//     We verify the bundled output directly, which is BOTH the artifact
//     that crashes in production AND something we can produce locally
//     without postject / .node staging.
//
// What we check:
//   1. The bundle (`dist/bundle.cjs`) has been freshly produced by the
//      `pretest` hook (build/bundle-for-sea-spec.mjs); we read it as a
//      string and grep for the rewritten call pattern.
//   2. The grep matches every `fileURLToPath\((?:[^)]*\.)?import_meta(\d*)\.url\)`
//      callsite. Allowed callers (by enclosing function name):
//        * `pty-host/host.ts:defaultChildEntrypoint` — only invoked when
//          spawning a pty-host child (post-`READY`); not on the boot path
//          for the LOADING_CONFIG → STARTING_LISTENERS sequence Task #463
//          unblocks.
//        * `index.ts:isDirectRun` — Task #463 wraps this in an `isSea()`
//          short-circuit so the throwing branch is unreachable in the SEA
//          carrier; the bundled body still mentions `import_meta_N.url`
//          inside the unreachable try-block.
//      DISALLOWED callers (any new occurrence of the pattern OUTSIDE the
//      two known-safe call sites) fail the test and force the dev to
//      either inline the resource (the Task #463 fix for migrations) or
//      gate the call behind `isSea()` like `isDirectRun` does.
//
// The test is intentionally text-based on `dist/bundle.cjs` — a stronger
// version would parse the bundle with @babel/parser and walk call sites,
// but the regex form catches every regression we have seen and stays cheap
// to evolve as the allowlist grows.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, '..', '..');
const DIST_DIR = join(PKG_DIR, 'dist');
const BUNDLE = join(DIST_DIR, 'bundle.cjs');

function readBundleOrFail(): string {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `dist/bundle.cjs missing — the \`pretest\` hook (build/bundle-for-sea-spec.mjs) ` +
        `should have produced it. If you are running this spec directly, run ` +
        `\`pnpm --filter @ccsm/daemon test\` (or invoke \`node build/bundle-for-sea-spec.mjs\` ` +
        `manually) first.`,
    );
  }
  return readFileSync(BUNDLE, 'utf8');
}

describe('daemon SEA bundle (Task #463)', () => {
  it('does not contain a fileURLToPath(import.meta.url) call on the boot path', () => {
    const bundle = readBundleOrFail();

    // Find every `fileURLToPath(<arg>.url)` call where <arg> is one of
    // esbuild's `import_meta` / `import_metaN` rewrites. A naive grep for
    // `import.meta.url` would miss these — esbuild aliases them.
    const callPattern = /fileURLToPath\)?\((?:\(0,\s*)?(?:[a-zA-Z_$][\w$]*\.)?(import_meta\d*)\.url\)/g;
    const hits: { match: string; lineNo: number; line: string }[] = [];
    const lines = bundle.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const re = new RegExp(callPattern.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        hits.push({ match: m[0], lineNo: i + 1, line: line.trim() });
      }
    }

    // Two known-safe call sites are allowed (see file header for rationale):
    //   * `pty-host/host.ts:defaultChildEntrypoint` — post-READY only.
    //   * `index.ts:isDirectRun` — gated behind `isSea()` short-circuit.
    // Anything else is a regression of Task #463.
    //
    // To attribute each hit to its enclosing function, we walk back from the
    // hit line until we find the most recent `function NAME(` declaration in
    // the bundled output (esbuild keeps function names intact for top-level
    // declarations; arrow/class methods would not match this regex but we do
    // not have any such shape on the boot path today).
    const allowedFunctionNames = new Set(['defaultChildEntrypoint', 'isDirectRun']);
    const fnDeclRe = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/;
    function enclosingFunctionName(lineIdx: number): string | null {
      for (let i = lineIdx; i >= 0; i--) {
        const m = fnDeclRe.exec(lines[i]);
        if (m) return m[1];
      }
      return null;
    }
    const allowed = hits.filter((h) => {
      const fn = enclosingFunctionName(h.lineNo - 1);
      return fn !== null && allowedFunctionNames.has(fn);
    });

    const disallowed = hits.filter((h) => !allowed.includes(h));

    expect(
      disallowed,
      [
        'Found fileURLToPath(import.meta.url) call(s) in bundle.cjs OUTSIDE the',
        'two known-safe call sites (pty-host defaultChildEntrypoint, index.ts',
        'isDirectRun). This will crash the SEA-bundled daemon at the phase the',
        'caller runs in — see Task #463. Fix by either inlining the resource',
        '(see src/db/migrations/inlined.ts for the migrations example) or by',
        'gating the call behind `isSea()` like isDirectRun does.',
        '',
        'Hits:',
        ...disallowed.map((h) => `  bundle.cjs:${h.lineNo}: ${h.line}`),
      ].join('\n'),
    ).toEqual([]);

    // Sanity: the allowlist is not empty — if it is, the regex broke and
    // the test is silently passing for the wrong reason.
    expect(allowed.length, 'allowlist hit count went to zero — regex is likely stale').toBeGreaterThan(
      0,
    );
  });

  it('migrations module is inlined (no readFileSync of *.sql in bundle)', () => {
    const bundle = readBundleOrFail();
    // `migrationFilePath` was removed from runner.ts in Task #463; if a
    // future refactor reintroduces a filesystem read of *.sql we want to
    // catch it here before it ships.
    expect(bundle).not.toMatch(/readFileSync\([^)]*\.sql/);
    // Sanity: the inlined SQL is actually present in the bundle. We
    // re-encode the on-disk 001_initial.sql and search for the resulting
    // base64 substring — this is what the inline-migrations.mjs script
    // emits into inlined.ts and what esbuild then bakes into bundle.cjs.
    const sqlBytes = readFileSync(join(PKG_DIR, 'src', 'db', 'migrations', '001_initial.sql'));
    const expectedB64 = sqlBytes.toString('base64');
    expect(bundle).toContain(expectedB64);
  });
});
