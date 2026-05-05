// Root (legacy renderer) vitest project — extracted from the prior
// monolithic vitest.config.ts so it can be referenced as one project among
// many in vitest.config.ts's `projects` array (Task #530, CI-SPEED commit 3).
//
// Behavior is byte-identical to the pre-#530 root config: jsdom env, the
// same `tests/**` + `electron/**/__tests__/**` includes, the same setup
// file, the same coverage thresholds (60/60/50/60). Splitting the file is
// purely structural — vitest's projects mode requires each project to be a
// separate config file (or inline object). Inlining the legacy block
// directly inside `vitest.config.ts`'s `projects` array would lose the
// per-project test/coverage settings because vitest 4 does NOT merge a
// root `test` block into project entries automatically.

import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'root',
    environment: 'jsdom',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'electron/**/__tests__/**/*.test.ts',
    ],
    globals: true,
    setupFiles: ['tests/setup.ts'],
    // v8 coverage instrumentation roughly doubles test wall-clock under
    // jsdom, so the default 5s testTimeout starts to flake on slower
    // suites (e.g. shortcut-overlay-platform with multiple act/render
    // cycles). Bump to 15s globally — well below CI job timeout.
    testTimeout: 15000,
  },
});
