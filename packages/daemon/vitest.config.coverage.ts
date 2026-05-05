// Daemon-package vitest config — coverage gate variant.
//
// Threshold currently 60% (raised from 50% by Task #436 sweep). Spec
// chapter 12 §6 mandates 80% as the v0.3 ship target; reaching that
// requires tests against src/index.ts, src/sessions/*, src/rpc/*, and
// src/crash/{filter-decider,pruner,raw-appender,sources} which are out
// of Task #436's scope (pty-host / sqlite / agent / importScanner only).
// Followup tasks should pick up the remaining ~18% gap incrementally.
// DO NOT relax further; the number only ever moves up.
//
// Why a separate file vs. extending vitest.config.ts:
//   The default `vitest.config.ts` includes `test/**/*.spec.ts` (integration
//   suites that spawn pty-host children, drive RPC roundtrips, run migration-
//   lock self-checks, etc.). Those are NOT unit tests and must not be folded
//   into the line-coverage denominator/numerator — chapter 12 §6 explicitly
//   measures unit coverage on `@ccsm/daemon/src` excluding `test/`. This
//   config narrows `include` to co-located unit specs and pins
//   `coverage.exclude` so the gate measures what the spec promises.
//
// Run:
//   pnpm --filter @ccsm/daemon test --coverage --config vitest.config.coverage.ts

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// CI installs deps with `npm ci --legacy-peer-deps` (see ci.yml "Install
// deps"), but the repo root `package.json` has no `workspaces` field — only
// `pnpm-workspace.yaml`. Result: under `cd packages/daemon && npx vitest`
// on CI, `@ccsm/proto` is not symlinked into `packages/daemon/node_modules/`
// and `import { ... } from '@ccsm/proto'` fails with ERR_MODULE_NOT_FOUND
// (e.g. src/rpc/__tests__/router.spec.ts). Locally, `pnpm install` creates
// the symlink so the same command passes — masking the gap. Resolve the
// package directly to its source entry (mirrors the `paths` mapping in the
// repo root tsconfig.json) so the unit-coverage gate works on CI too.
const protoSrcIndex = fileURLToPath(
  new URL('../proto/src/index.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      '@ccsm/proto': protoSrcIndex,
    },
  },
  test: {
    environment: 'node',
    // Unit-only: co-located specs under src/. Excludes test/** (integration),
    // build/** (SEA build pipeline), eslint-plugins/** (RuleTester suites).
    //
    // Also excludes `src/**/integration.spec.ts` — by naming convention these
    // are cross-process / h2c-loopback specs that spawn real Connect servers
    // (e.g. src/rpc/__tests__/integration.spec.ts boots an h2c listener) and
    // belong to the integration tier per chapter 12 §3, not the unit gate.
    // They are kept under src/__tests__/ for proximity to the module they
    // exercise but must not count toward unit coverage.
    include: ['src/**/*.spec.ts', 'src/**/__tests__/**/*.spec.ts'],
    exclude: ['**/integration.spec.ts'],
    globals: false,
    // v8 coverage instrumentation roughly doubles wall-clock for IO-heavy
    // unit tests under Windows; sqlite-backed specs (e.g.
    // src/db/__tests__/recovery.spec.ts which seeds 200 rows in a non-
    // transactional loop then scribbles page bytes to corrupt the file)
    // exhibit huge wall-clock variance on windows-latest shared runners:
    // observed 9s on one run, >30s timeout on the next. Bump the per-test
    // ceiling to 60s so genuine product hangs still surface fast vs the
    // 15-min job ceiling, but instrumented sqlite IO has comfortable
    // headroom. Followup: speed up recovery.spec by wrapping the seed loop
    // in `db.transaction(...)()` (1 fsync vs 200) — tracked in #350.
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Excludes per chapter 12 §6: `dist/`, `gen/`, `test/`. Spec files and
      // their __tests__/ siblings are excluded so test code itself doesn't
      // inflate the coverage numerator.
      exclude: [
        'dist/**',
        'gen/**',
        'test/**',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
      ],
      thresholds: {
        // Raised from 50% to 60% by Task #436 (pty-host / sqlite / agent /
        // importScanner sweep). Local windows-11 measure is 61.6% — the
        // 1.6% buffer absorbs minor v8 instrumentation variance across
        // platforms. Spec ch12 §6 ship target is 80%; followup tasks must
        // cover scope-out files (src/index.ts, src/sessions/*, src/rpc/*,
        // src/crash/{filter-decider,pruner,raw-appender,sources}) before
        // the threshold can move there without violating Task #436's
        // 4-directory boundary.
        lines: 60,
      },
    },
  },
});
