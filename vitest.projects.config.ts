// Vitest projects-mode config — Task #530 (CI-SPEED commit 3, gated rollout).
//
// STATUS: STRUCTURAL ONLY — DO NOT WIRE INTO CI YET.
//
// This file is INTENTIONALLY SEPARATE from the root vitest.config.ts so the
// existing `vitest run` invocations (test:app, coverage, test:watch) keep
// their pre-#530 behavior (root renderer suite only). Projects mode is
// opted into via `npm run test:projects`, which passes
// `--config vitest.projects.config.ts` to vitest.
//
// Why projects mode (target end state): CI today launches three independent
// vitest processes back-to-back (root coverage, daemon coverage, electron
// coverage) — each pays ~10-20s of vitest startup + worker pool warmup.
// Folding into one root vitest run amortizes startup once across all
// three. Local measure target: 3× spawn ≈ ~75s vs single projects-mode
// run ≈ ~50s.
//
// GATED ROLLOUT (灰度) — ci.yml's three independent coverage steps are
// LEFT IN PLACE in this PR. Two known vitest 4 gaps prevent the cutover:
//
//   1. Per-project `coverage.thresholds` are NOT enforced — vitest 4
//      aggregates coverage at workspace root only. Daemon's 60% lines
//      gate and electron's 60% lines gate would have to merge into a
//      single workspace gate (potentially false-failing if either
//      project drops). Per-project gates need either upstream support
//      (vitest issue) or per-package CI jobs reimplemented as before.
//
//   2. Per-project `include` globs (e.g.
//      `packages/daemon/vitest.config.coverage.ts` declares
//      `include: ['src/**/*.spec.ts', 'src/**/__tests__/**/*.spec.ts']`)
//      are resolved relative to the PROJECT cwd when run directly
//      (`cd packages/daemon && vitest`) but appear to fall back to
//      auto-discovery when run via the root projects config. As a
//      result, `packages/daemon/test/**` integration specs leak into
//      the projects-mode run with their `@ccsm/snapshot-codec` import
//      breaking because the workspace symlink isn't reflected in the
//      root resolver. Fixing this requires either rewriting include
//      globs to be root-relative (`packages/daemon/src/**/*.spec.ts`)
//      or pinning each project's `root` field — neither is in scope
//      for this commit.
//
// ROAD-MAP for the cutover PR:
//   1. Rewrite per-package include globs to absolute or root-relative
//      paths so projects mode picks up ONLY the intended specs.
//   2. Decide per-project threshold story (split CI jobs vs upstream
//      vitest fix) and update accordingly.
//   3. Replace ci.yml's three coverage spawn steps with a single
//      `npm run test:projects -- --coverage` call.
//   4. Verify coverage numbers match the pre-cutover baseline.
//
// For NOW this commit ships:
//   - this file (the dispatcher),
//   - vitest.config.root.ts (the legacy root suite extracted into a
//     defineProject() entry — byte-identical behavior),
//   - the `test:projects` npm script (smoke entry for local dev).
//
// CI is unaffected; commit 1 (dist artifact) and commit 2 (turbo cache)
// carry the wall-time reduction for this PR.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const protoSrcIndex = fileURLToPath(
  new URL('./packages/proto/src/index.ts', import.meta.url),
);

export default defineConfig({
  projects: [
    './vitest.config.root.ts',
    './packages/daemon/vitest.config.coverage.ts',
    './packages/electron/vitest.config.ts',
  ],
  resolve: {
    alias: {
      '@ccsm/proto': protoSrcIndex,
    },
  },
});
