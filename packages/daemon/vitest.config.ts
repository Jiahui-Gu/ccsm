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
    // `test/**` holds out-of-tree integration / harness / contract specs
    // that cannot be co-located with src (they instantiate cross-module
    // fixtures, read packaged migrations/fixtures, or are forever-stable
    // contract specs per design spec ch12 §3). Examples:
    //   - test/supervisor/contract.spec.ts (golden response bodies)
    //   - test/pty-host/ (T4.1 child_process.fork lifecycle)
    //   - test/db/migration-lock.spec.ts (T10.1 migration lock self-check)
    //   - test/integration/pty-soak-{1h,10m}.spec.ts (T8.4 PTY soak ship-gate)
    // Note: forward-compat placeholder specs may hard-fail until their
    // dependencies land — land the dep in the same PR that re-includes,
    // or keep the spec under `src/<sub>/__tests__/`.
    include: [
      'src/**/*.spec.ts',
      'build/**/*.spec.ts',
      'eslint-plugins/**/*.spec.ts',
      'test/**/*.spec.ts',
    ],
    globals: false,
  },
});
