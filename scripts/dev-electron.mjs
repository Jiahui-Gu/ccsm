#!/usr/bin/env node
// Dev-only wrapper around `electron .`. Two pieces of friction it removes:
//
//   1. Single-instance lock.  ccsm's prod build calls
//      `app.requestSingleInstanceLock()` at module load so duplicate desktop-
//      icon double-clicks don't fork zombies. When you're using your installed
//      ccsm to develop ccsm, that lock also blocks `npm run dev`. The lock
//      already has an opt-out (`CCSM_E2E_NO_SINGLE_INSTANCE=1`, originally
//      added for parallel E2E probes); this wrapper sets it.
//
//   2. userData collision.  Electron derives `app.getPath('userData')` from
//      `productName`, which is "CCSM" in both prod and dev. Without an
//      override, dev runs would read/write the same SQLite DB and prefs as
//      your installed ccsm — risky even after exit (WAL recovery, schema
//      migrations). We point the dev instance at `.dev-userdata/` inside the
//      worktree via Electron's `--user-data-dir` switch.
//
// Cross-platform: spawning Node with explicit arg/env propagation works on
// Windows without `cross-env`. Stdio is inherited so logs and Ctrl-C behave
// exactly like running `electron .` directly.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const userDataDir = resolve(repoRoot, '.dev-userdata');
mkdirSync(userDataDir, { recursive: true });

const electronBinary = createRequire(import.meta.url)('electron');

const child = spawn(
  electronBinary,
  [`--user-data-dir=${userDataDir}`, repoRoot],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CCSM_E2E_NO_SINGLE_INSTANCE: '1',
      // Dev-loop ergonomics (Task #11): closing the main window during
      // `npm run dev` should fully quit the Electron app instead of
      // going production tray-resident, so concurrently's `-k` reaps
      // the sibling `dev:web` (webpack-dev-server on :4100). Without
      // this, closing the window leaves the Electron main proc alive
      // in the tray AND keeps webpack-dev-server holding port 4100 —
      // every restart needed a manual taskkill. Scoped to this wrapper
      // so manual `electron .` runs and e2e probes still get the real
      // close-to-tray choreography. Read by
      // `electron/window/createWindow.ts`.
      CCSM_DEV_QUIT_ON_CLOSE: '1',
    },
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
