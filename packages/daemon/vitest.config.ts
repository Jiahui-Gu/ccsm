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
      // `test/**` is the home for forever-stable invariants specs that watch
      // shipped constants for accidental drift (T10.1 migration-lock, T10.7
      // state-dir paths, etc.). They live outside `src/` so they cannot be
      // accidentally pulled into the runtime bundle (`tsconfig.json` rootDir
      // is `src`).
      'test/**/*.spec.ts',
    ],
    globals: false,
  },
});
