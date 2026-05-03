// Vitest config for @ccsm/snapshot-codec. Co-located `*.spec.ts` files
// next to the source they cover (matches the @ccsm/daemon convention).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
  },
});
