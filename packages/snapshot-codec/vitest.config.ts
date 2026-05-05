// Vitest config for @ccsm/snapshot-codec. Co-located `*.spec.ts` files
// next to the source they cover (matches the @ccsm/daemon convention).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
    // Mirror packages/proto/vitest.config.ts: ship the codec package
    // even when no co-located *.spec.ts has landed yet (per-step unskip
    // workflow lands round-trip coverage in daemon's integration spec
    // family — `pty-daemon-restart-replay.spec.ts` — rather than here).
    passWithNoTests: true,
  },
});
