// @ccsm/electron vitest config — co-located unit + e2e specs.
//
// Why a per-package config (mirrors packages/daemon/vitest.config.ts and
// packages/proto/vitest.config.ts):
//   The repo-root `vitest.config.ts` restricts `include` to `tests/**` and
//   the legacy `electron/**` paths and pulls in jsdom. The new monorepo
//   package at `packages/electron/` lives outside both globs and its e2e
//   suite is pure node (Playwright `_electron.launch` drives a real Electron
//   process, not jsdom). Same separation pattern as the daemon and proto
//   packages.
//
// Run with:
//   pnpm --filter @ccsm/electron test
// or:
//   npx vitest run --config packages/electron/vitest.config.ts

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
      'test/**/*.spec.ts',
      'test/**/*.spec.tsx',
    ],
    globals: false,
    // E2E specs spawn real Electron + daemon subprocesses (per-PR variant
    // ~30s; nightly soak variant ~60m). Default vitest timeout is 5s, far
    // too short for either path. The 70m ceiling covers the nightly soak
    // with 10 minutes of slack for daemon-restart + byte-equality encode.
    testTimeout: Number(process.env.CCSM_VITEST_TIMEOUT_MS ?? 70 * 60 * 1000),
    hookTimeout: 60 * 1000,
    // Coverage gate per chapter 12 §6: 60% lines on renderer code. Renderer
    // currently measures ~85% locally so the gate is live (real, not aspirational).
    // UI-shell paths (windowing/tray) are excluded because they require a real
    // BrowserWindow and aren't unit-testable; same exclusions used by the
    // legacy renderer suite.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'dist/**',
        'test/**',
        'src/**/*.spec.ts',
        'src/**/*.spec.tsx',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 60,
      },
    },
  },
});
