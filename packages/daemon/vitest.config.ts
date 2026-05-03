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
      // T8.11 + T8.x integration specs live under test/integration/. Spec
      // ch12 §3 mandates the `.spec.ts` extension uniformly across all
      // layers (no `.test.ts`). The legacy `test/db/migration-lock.spec.ts`
      // unit-style placement is also covered by `test/**/*.spec.ts`.
      'test/**/*.spec.ts',
    ],
    globals: false,
  },
});
