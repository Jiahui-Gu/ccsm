import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'electron/**/__tests__/**/*.test.ts'
    ],
    globals: true,
    setupFiles: ['tests/setup.ts']
  }
});
