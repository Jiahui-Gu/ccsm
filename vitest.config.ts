import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
        // ~79% to ~83.6% on the same suite. See PR body for justification.
        'electron/main.ts',
        'electron/testHooks.ts',
        'electron/db-validate.ts',
        'electron/agent/read-default-model.ts',
        'electron/branding/icon.ts',
        'electron/sentry/init.ts',
        'electron/tray/createTray.ts',
        'electron/ipc/*Ipc.ts',
        'electron/notify/badge.ts',
        'src/index.tsx',
        'src/components/ScrollToBottomButton.tsx',
      ],
      // Task #43 — gate is now enforced in CI. Thresholds set ~5pp below
      // measured post-exclusion baseline (lines ~83.6%, statements ~81%,
      // functions ~81%, branches ~73%) so normal week-to-week churn
      // doesn't flake the gate, while regressions of >5pp are caught.
      // Raise these as suites grow; never lower without a written
      // justification in the PR body.
      thresholds: {
        lines: 78,
        functions: 76,
        branches: 68,
        statements: 76,
      },
    },
  },
});
