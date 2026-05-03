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
    include: [
      'src/**/*.spec.ts',
      'build/**/*.spec.ts',
      'eslint-plugins/**/*.spec.ts',
      // Cross-cutting integration tests that don't fit neatly under a
      // single `src/<sub>/__tests__/` directory live in `test/<topic>/`.
      // Currently: `test/pty-host/` (T4.1 child_process.fork lifecycle).
      // The forward-compat `test/db/migration-lock.spec.ts` placeholder
      // is intentionally NOT picked up yet — its top-level readFileSync
      // hard-fails until Task #56 lands `src/db/locked.ts`. That spec
      // wires itself in once locked.ts exists (it can be re-included
      // here in the same PR, or moved under `src/db/__tests__/`).
      'test/pty-host/**/*.spec.ts',
    ],
    globals: false,
  },
});
