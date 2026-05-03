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
    // `test/**` holds out-of-tree integration / harness specs that
    // cannot be co-located with src (they instantiate cross-module
    // fixtures and read from packaged migrations / fixtures). Examples:
    // T10.1 migration lock self-check (`test/db/migration-lock.spec.ts`);
    // T8.4 PTY soak ship-gate (`test/integration/pty-soak-{1h,10m}.spec.ts`).
    include: [
      'src/**/*.spec.ts',
      'build/**/*.spec.ts',
      'eslint-plugins/**/*.spec.ts',
      'test/**/*.spec.ts',
    ],
    globals: false,
  },
});
