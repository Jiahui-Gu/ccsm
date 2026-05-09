// Playwright config for the standalone cloud-e2e harness (Task #82).
//
// Why standalone (not in packages/ or in the pnpm workspace):
//   - The monorepo's `pnpm-workspace.yaml` only globs `packages/*`, so this
//     tool stays out of the workspace install graph and avoids hot-file
//     mutex contention on the root lockfile when manager runs it ad-hoc.
//   - Target is the *deployed* cc-sm.pages.dev cloud SPA; no local fixtures,
//     no orchestrator, no daemon spawn — manager just runs `pnpm test`.
//
// Failure artifacts (trace.zip, screenshots, video) land in
// `test-results/` so the manager can inspect them after a red run.
//
// S4-T9 (Task #135) addendum: `cross-user-isolation.spec.ts` is a raw
// WebSocket spec (no SPA boot) and reads three env vars directly from
// `process.env` inside the spec body:
//   - CCSM_CLOUD_WS_BASE       — ws origin of the running wrangler dev
//   - JWT_SIGNING_KEY          — must match `.dev.vars` in cf-worker
//   - JWT_REFRESH_SIGNING_KEY  — must match `.dev.vars` in cf-worker
// Playwright forwards process.env into spec workers by default so no
// explicit `use:` plumbing is required — the spec auto-skips when those
// vars are absent so the existing two-tab spec keeps running unchanged
// against deployed cc-sm.pages.dev.
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.CCSM_CLOUD_BASE_URL ?? 'https://cc-sm.pages.dev';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
