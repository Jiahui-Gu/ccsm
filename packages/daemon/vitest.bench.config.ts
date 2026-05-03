// Daemon bench config (T8.13). Separate from the main `vitest.config.ts`
// to keep `npm test` fast and CI-deterministic — bench files run via
// `vitest bench --config vitest.bench.config.ts --run packages/daemon/test/bench/`
// on the nightly schedule (design spec ch12 §7).
//
// Why a separate config (not just relying on auto-discovery):
//   - The main `vitest.config.ts` pins `include: ['**/*.spec.ts']` — `bench.ts`
//     files would NOT be picked up there even though vitest's default
//     discovery includes them. Adding `*.bench.ts` to the main include
//     would surface bench files inside `vitest run` which we explicitly
//     do not want (bench runs are wall-clock heavy and noisy in CI).
//   - Bench needs different reporter defaults (verbose stdout for the
//     nightly job to scrape p50/p99 numbers) than spec runs.
//
// Numbers are advisory in this config; the only blocking gate is
// SendInput p99 which is enforced by the soak harness (Task #92), not
// here. This file is the "where do we record numbers" half — actual
// gating lives with the soak ship-gate.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/bench/**/*.bench.ts'],
    // Vitest bench uses tinybench under the hood — leave its defaults
    // (iterations / time / warmup) alone unless a specific bench file
    // overrides them inline. Defaults: time=500ms, warmupTime=100ms.
    benchmark: {
      reporters: ['default'],
    },
    globals: false,
  },
});
