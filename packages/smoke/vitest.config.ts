import { defineConfig } from 'vitest/config';

// R-14 (Task #34) — vitest config for smoke package's pure-TS unit tests.
// Only `wait-http-stable.test.ts` lives here; orchestrator + playwright e2e
// fixtures stay under `tests/` and are run via `pnpm smoke` (separate harness).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
