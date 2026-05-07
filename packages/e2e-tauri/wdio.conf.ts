// WDIO config for Tauri 2 desktop smoke (Windows-only).
//
// Architecture (per `tauri-driver` docs, https://v2.tauri.app/develop/tests/webdriver/):
//   wdio  ──HTTP──>  tauri-driver (port 4444)  ──spawns──>  msedgedriver (port 4445)
//                                              ──launches──> ccsm-tauri.exe (WebView2)
//
// `tauri-driver` is a thin proxy: WebDriver "new session" with capability
// `tauri:options.application` makes it spawn the given .exe and attach the
// child WebView2 to msedgedriver. WebView2 is Chromium, so msedgedriver
// (147.x to match installed Edge) is the right driver — confirmed by
// project_tauri2_spike_2026_05_07 memo.
//
// Pre-reqs (manual, see packages/e2e-tauri/README — no, we don't add docs;
// see PR body):
//   1. cargo install tauri-driver --locked   (>=2.0 for Tauri 2)
//   2. msedgedriver.exe matching local Edge version on PATH or via
//      TAURI_E2E_MSEDGEDRIVER env (defaults to ~/bin/msedgedriver.exe)
//   3. ccsm-tauri.exe built: pnpm -F @ccsm/frontend-tauri tauri build

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTauriDriver } from './fixtures/tauri-app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TAURI_APP =
  process.env.TAURI_E2E_APP ??
  path.join(
    REPO_ROOT,
    'packages',
    'frontend-tauri',
    'src-tauri',
    'target',
    'release',
    'ccsm-tauri.exe',
  );

let driverHandle: { kill: () => void } | null = null;

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [path.join(__dirname, 'tests', '**', '*.spec.ts')],
  maxInstances: 1,
  capabilities: [
    {
      // No `browserName` — per https://v2.tauri.app/develop/tests/webdriver/
      // example/webdriverio/, tauri-driver consumes the `tauri:options.application`
      // capability and launches the .exe under msedgedriver itself. Setting
      // browserName=wry causes WebDriverIO to fall back to a plain Edge
      // session against about:blank instead of attaching to ccsm-tauri.exe.
      maxInstances: 1,
      'tauri:options': {
        application: TAURI_APP,
      },
    } as unknown as WebdriverIO.Capabilities,
  ],
  hostname: '127.0.0.1',
  port: 4444,
  path: '/',
  logLevel: 'info',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 90_000,
  },
  // tauri-driver lifecycle: spawn before session, kill after.
  // We do it in onPrepare/onComplete (worker-level) so the spec sees it ready.
  onPrepare: async () => {
    driverHandle = await spawnTauriDriver();
  },
  onComplete: () => {
    driverHandle?.kill();
    driverHandle = null;
  },
};
