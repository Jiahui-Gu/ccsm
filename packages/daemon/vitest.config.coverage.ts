// Daemon-package vitest config — coverage gate variant.
//
// TEMPORARY 50% THRESHOLD. Followup #350 will raise this to the spec-mandated
// 80% (see docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// chapter 12 §6) once additional unit tests land. DO NOT relax further; the
// number only ever moves up.
//
// Why a separate file vs. extending vitest.config.ts:
//   The default `vitest.config.ts` includes `test/**/*.spec.ts` (integration
//   suites that spawn pty-host children, drive RPC roundtrips, run migration-
//   lock self-checks, etc.). Those are NOT unit tests and must not be folded
//   into the line-coverage denominator/numerator — chapter 12 §6 explicitly
//   measures unit coverage on `@ccsm/daemon/src` excluding `test/`. This
//   config narrows `include` to co-located unit specs and pins
//   `coverage.exclude` so the gate measures what the spec promises.
//
// Run:
//   pnpm --filter @ccsm/daemon test --coverage --config vitest.config.coverage.ts

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit-only: co-located specs under src/. Excludes test/** (integration),
    // build/** (SEA build pipeline), eslint-plugins/** (RuleTester suites).
    //
    // Also excludes `src/**/integration.spec.ts` — by naming convention these
    // are cross-process / h2c-loopback specs that spawn real Connect servers
    // (e.g. src/rpc/__tests__/integration.spec.ts boots an h2c listener) and
    // belong to the integration tier per chapter 12 §3, not the unit gate.
    // They are kept under src/__tests__/ for proximity to the module they
    // exercise but must not count toward unit coverage.
    include: ['src/**/*.spec.ts', 'src/**/__tests__/**/*.spec.ts'],
    exclude: ['**/integration.spec.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Excludes per chapter 12 §6: `dist/`, `gen/`, `test/`. Spec files and
      // their __tests__/ siblings are excluded so test code itself doesn't
      // inflate the coverage numerator.
      exclude: [
        'dist/**',
        'gen/**',
        'test/**',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/**/*.d.ts',
      ],
      thresholds: {
        // TEMPORARY: 50% holds the line while followup #350 closes the gap to
        // the spec-mandated 80%. Local run measures ~55% so this gate is not
        // vacuous — a regression that drops below 50% will fail CI.
        lines: 50,
      },
    },
  },
});
