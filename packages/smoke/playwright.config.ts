// Local-only S3 happy-path smoke (Task #2).
//
// Not in CI: wrangler dev + tauri dev + real chromium are flaky on hosted
// runners (workerd platform binaries, MSI installer, no display). Run from a
// dev workstation. globalSetup orchestrates 3 long-lived child processes
// (wrangler dev for cf-worker, vite/wrangler-pages-dev for frontend-web,
// tauri dev which in turn spawns the daemon as a Rust child process), waits
// for all 3 ready signals, then Playwright drives chromium against the Pages
// frontend. globalTeardown reverses the spawn order.
//
// Why Tauri spawns the daemon (memory: project_tauri_spawns_daemon.md): the
// product design forbids a CLI-direct daemon launch; daemon must always be
// owned by the Tauri shell so token + db_path + Job Object lifetimes are the
// product's responsibility, not the test's. This means the smoke harness
// never runs `node dist/index.mjs` directly.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Single worker — orchestrating wrangler+tauri+pages once is expensive,
  // and the spec is happy-path-only (one session, one command).
  workers: 1,
  fullyParallel: false,
  // Local dev workstations vary; bump default 30s so the orchestrator has
  // breathing room when wrangler downloads workerd or tauri rebuilds Rust.
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [['list']],
  use: {
    // The actual baseURL is computed in globalSetup once Pages dev is up;
    // forwarded via process.env.SMOKE_BASE_URL so individual tests can hit
    // it without re-doing the port discovery dance.
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  globalSetup: './fixtures/orchestrator.ts',
  globalTeardown: './fixtures/orchestrator.ts',
});
