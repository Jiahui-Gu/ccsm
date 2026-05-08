import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    alias: {
      // The `cloudflare:workers` virtual module is only available in the
      // workerd runtime; stub it for unit tests so importing the DO doesn't
      // fail at module-resolve time (Task #790, S3-E hibernation).
      'cloudflare:workers': fileURLToPath(
        new URL('./test/stubs/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
});
