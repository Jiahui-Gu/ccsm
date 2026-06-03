import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Two projects, split by the runtime the code under test actually runs in.
    // This is the whole point of the node:sqlite migration: main-process code
    // (electron/**) runs under Node, not a browser. Running its tests under
    // jsdom drove vitest's client bundler to try inlining the `node:sqlite`
    // built-in and fail with "Cannot bundle Node.js built-in node:sqlite".
    // Under the `node` environment the built-in stays a runtime require, as it
    // is in production. Renderer tests (src/** via tests/**) keep jsdom.
    projects: [
      {
        extends: true,
        test: {
          name: 'electron',
          environment: 'node',
          include: ['electron/**/__tests__/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['tests/setup.ts'],
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
        },
      },
    ],
    globals: true,
    // v8 coverage instrumentation roughly doubles test wall-clock under
    // jsdom, so the default 5s testTimeout starts to flake on slower
    // suites (e.g. shortcut-overlay-platform with multiple act/render
    // cycles). Bump to 15s globally — well below CI job timeout, and
    // leaves headroom for `npm run coverage`.
    testTimeout: 15000,
    // Tech-debt R6 (Task #802) — coverage tooling. Reporters cover both
    // human (text) and machine (json-summary, lcov) consumers; lcov is
    // what CI uploads as an artifact.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        'tests/**',
        'scripts/**',
        'dist/**',
        // Procedural / bootstrap files (Task #43) — pure wiring with no
        // branching logic, not meaningfully unit-testable. Covered by e2e
        // smoke + manual dogfood. Excluding lifts headline `lines` from
        // ~79% to ~87.1% on the same suite. See PR body for justification.
        'electron/main.ts',
        'electron/testHooks.ts',
        'electron/db-validate.ts',
        'electron/agent/read-default-model.ts',
        'electron/branding/icon.ts',
        'electron/sentry/init.ts',
        'electron/tray/createTray.ts',
        'electron/ipc/systemIpc.ts',
        'electron/ipc/windowIpc.ts',
        'electron/notify/badge.ts',
        'src/index.tsx',
        'src/components/ScrollToBottomButton.tsx',
      ],
      // Tech-debt R6 (Task #43) — gate is enforced in CI. Thresholds set
      // ~3pp below the measured post-exclusion baseline (2026-05-25:
      // lines 84.46%, statements 82.34%, functions 84.84%, branches 73.69%)
      // so normal week-to-week churn doesn't flake the gate, while
      // regressions of >3pp are caught — tightened from the earlier ~8pp
      // buffer per technical-debt audit 2026-05-25.
      // Raise these as suites grow; never lower without a written
      // justification in the PR body.
      thresholds: {
        lines: 81,
        functions: 81,
        branches: 70,
        statements: 79,
      },
    },
  },
});
