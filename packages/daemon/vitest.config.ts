// Daemon-package vitest config. Co-located `*.spec.ts` files next to the
// source they cover (vs. the root `tests/**/*.test.ts` convention used by
// the legacy renderer/electron code). Daemon code is pure node — no jsdom.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `eslint-plugins/**` holds the local ESLint plugin source + its
    // RuleTester suite (e.g. T1.9 ccsm/no-listener-slot-mutation). They
    // are not under `src/` because they are tooling, not daemon runtime.
    // `build/**` holds the SEA build pipeline tooling + tests (T7.1).
    // `test/**` holds integration + forever-stable contract specs per
    // design spec ch12 §3 (e.g. test/supervisor/contract.spec.ts).
    include: [
      'src/**/*.spec.ts',
      'build/**/*.spec.ts',
      'eslint-plugins/**/*.spec.ts',
      // Cross-cutting integration tests that don't fit neatly under a
      // single `src/<sub>/__tests__/` directory live in `test/<topic>/`
      // (e.g. test/supervisor/, test/pty-host/). Picked up broadly.
      // Note: forward-compat placeholder specs (e.g. test/db/migration-lock)
      // may hard-fail until their dependencies land — re-include those in
      // the same PR that lands the dep, or move under `src/<sub>/__tests__/`.
      'test/**/*.spec.ts',
    ],
    globals: false,
  },
});
