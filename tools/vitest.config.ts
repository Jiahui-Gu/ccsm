/**
 * tools/vitest.config.ts
 *
 * Minimal vitest config for repo-shape smoke tests under `tools/`.
 *
 * Why a separate config:
 *   The root `vitest.config.ts` restricts `include` to `tests/**` and
 *   `electron/**\/__tests__/**` and pulls in jsdom + a heavy setup file
 *   (tests/setup.ts). Tools-level shape checks are pure node — no DOM,
 *   no setup — and live outside those directories. Reusing the root
 *   config would either silently skip these specs (path arg becomes a
 *   filter, not an include override) or pay the jsdom startup cost for
 *   no reason.
 *
 *   Run with:
 *     npx vitest run --config tools/vitest.config.ts
 *
 * No new deps: vitest is already a root devDependency.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/**/*.spec.ts'],
    // Keep this file FOREVER-MINIMAL. Tools specs must not need globals,
    // setup files, or coverage instrumentation.
    globals: false,
    // Tools specs spawn many `git` invocations against tmp-dir fixtures
    // (e.g. tools/test/check-v02-shrinking.spec.ts builds 4-6-commit
    // branch histories per case). On Windows runners each `git` shell
    // out costs 100-300ms; the default 5s testTimeout flakes the
    // step-wise cases. 30s leaves comfortable headroom on every OS in
    // the CI matrix while staying well under the 10-minute job cap.
    testTimeout: 30000,
  },
});
