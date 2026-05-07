import { defineConfig } from 'vitest/config';

// @ccsm/ui — React-side test config. Component tests use jsdom; pure store
// tests don't but the env switch is per-suite via /** @vitest-environment **/
// pragmas, so a single jsdom default keeps the config tiny.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
