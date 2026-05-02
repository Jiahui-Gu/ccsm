// @ccsm/proto vitest config — co-located contract tests under
// `test/contract/*.spec.ts` per design spec ch04 §7.1 (T0.12).
//
// Why a separate config:
//   The root `vitest.config.ts` restricts `include` to `tests/**` and
//   `electron/**` and pulls in jsdom + a heavy setup file. Proto contract
//   tests are pure node — no DOM, no setup — and must not pay the jsdom
//   startup cost. Same pattern as `tools/vitest.config.ts` and
//   `packages/daemon/vitest.config.ts`.
//
//   Run with:
//     pnpm --filter @ccsm/proto test
//   or:
//     npx vitest run --config packages/proto/vitest.config.ts

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    globals: false,
  },
});
