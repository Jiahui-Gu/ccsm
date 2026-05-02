import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM equivalent of __dirname — required because this file is loaded as ESM
// (`.mts`) so vitest's config loader can resolve ESM-only deps such as
// `std-env` (pulled in transitively by vitest 4.x / pino).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ccsm/proto-gen/v1': path.resolve(__dirname, 'gen/ts/ccsm/v1/index.ts'),
      '@ccsm/proto-gen': path.resolve(__dirname, 'gen/ts/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'electron/**/__tests__/**/*.test.ts',
      'daemon/**/__tests__/**/*.test.ts',
      'installer/**/__tests__/**/*.test.ts',
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
      ],
      // Initial roll-out — start lenient. Adjusted to current actuals
      // (see PR #802 body for measured numbers). Bump in follow-up tasks
      // as suites grow. Thresholds are NOT enforced in CI yet — the CI
      // job runs `npm run coverage` to produce lcov.info as an artifact
      // but does not fail on threshold misses for this initial roll-out.
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
  },
});
