import { defineConfig, devices } from '@playwright/test';

// ccsm e2e rig (Task #664).
//
// Defaults are tuned so that ALL acceptance evidence is machine-readable:
// - headless: true — no human-in-the-loop required
// - screenshot: 'off' — we manage screenshots manually via fixtures/screenshot.ts
//   so each snap produces both a .png and a .txt sibling.
// - fullyParallel: false — the daemon fixture spawns a single child process per
//   test file and binds to a port; serializing avoids port races for now.
// - reporter: list (CLI) + html (artifact uploaded by CI).
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    headless: true,
    screenshot: 'off',
    trace: 'on-first-retry',
    video: 'off',
  },
  // Multi-browser projects (Task #752).
  //
  // Local Windows runs all four (chromium / firefox / webkit / edge). The
  // CI three-platform matrix arrives in #755 — on ubuntu/macos the
  // `edge` channel relies on a system Microsoft Edge install which is
  // not shipped by Playwright; #755 will gate edge to windows runners.
  //
  // Per-browser known-issue skips live in the spec (test.skip(browserName,
  // ...)) with a documented reason — never silently hide a browser.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
  ],
});
