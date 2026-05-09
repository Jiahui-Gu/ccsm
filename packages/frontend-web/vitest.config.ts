import { defineConfig } from 'vitest/config';

// frontend-web tests use jsdom for component-level coverage of AuthContext +
// SignInGate (Task #139, S4-T7). Pure-logic suites (resolveToken,
// hostConfig) run fine under jsdom too, so a single env keeps config small.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    environmentOptions: {
      jsdom: {
        url: 'http://127.0.0.1/',
      },
    },
  },
});
