import { defineConfig } from 'vitest/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM equivalent of __dirname — required because this file is loaded as ESM
// (`.mts`) so vitest's config loader can resolve ESM-only deps such as
// `std-env` (pulled in transitively by vitest 4.x / pino).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sharedResolve = {
  alias: {
    '@ccsm/proto-gen/v1': path.resolve(__dirname, 'gen/ts/ccsm/v1/index.ts'),
    '@ccsm/proto-gen': path.resolve(__dirname, 'gen/ts/index.ts'),
  },
};

// Tests that genuinely need a browser-like environment (jsdom). Everything
// else runs under the `node` project so that loading vitest does not pull
// jsdom (which transitively imports html-encoding-sniffer@6 — an ESM-only
// package whose @exodus/bytes dep crashes our CI loader). See task #172.
const DOM_TESTS = [
  // All component tests written as .tsx use @testing-library/react.
  'tests/**/*.test.tsx',
  // .ts tests that touch DOM globals or import @testing-library/react.
  'tests/store-rename-session.test.ts',
  'tests/store-backfill-titles.test.ts',
  'tests/store-preferences.test.ts',
  'tests/sidebar/useSidebarDnd.test.ts',
  'tests/components/cwd/useCwdRecentList.test.ts',
  'tests/components/cwd/useCwdPanelPosition.test.ts',
  'tests/agent-lifecycle-unfocused.test.ts',
  'tests/drafts.test.ts',
  'tests/stores/slices/sessionTitleBackfillSlice.test.ts',
  'tests/stores/slices/sessionCrudSlice.test.ts',
];

const NODE_INCLUDE = [
  'tests/**/*.test.ts',
  'electron/**/__tests__/**/*.test.ts',
  'daemon/**/__tests__/**/*.test.ts',
  'installer/**/__tests__/**/*.test.ts',
];

export default defineConfig({
  resolve: sharedResolve,
  test: {
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
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
    projects: [
      {
        resolve: sharedResolve,
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          include: NODE_INCLUDE,
          // Skip anything that needs DOM — those run under the `dom`
          // project below. We exclude .tsx outright (none of them are
          // DOM-free) plus the hand-curated list of .ts files that
          // depend on jsdom globals.
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'tests/**/*.test.tsx',
            ...DOM_TESTS,
          ],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          name: 'dom',
          environment: 'jsdom',
          globals: true,
          include: DOM_TESTS,
          setupFiles: ['tests/setup.ts'],
        },
      },
    ],
  },
});
