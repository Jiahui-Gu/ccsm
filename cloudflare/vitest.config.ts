import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const { cloudflareTest } = await import('@cloudflare/vitest-pool-workers');

  return {
    plugins: [
      cloudflareTest({
        main: './cloudflare/src/worker.ts',
        miniflare: {
          compatibilityDate: '2026-07-15',
          durableObjects: { RELAY: 'RelayRoom' },
          serviceBindings: {
            ASSETS: async () => new globalThis.Response('asset'),
          },
        },
      }),
    ],
    test: {
      include: ['cloudflare/test/**/*.test.ts'],
    },
  };
});
