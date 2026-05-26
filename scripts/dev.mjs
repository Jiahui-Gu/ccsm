#!/usr/bin/env node
// Entry point for `npm run dev`. Replaces the old
// `concurrently -k -n web,app "npm:dev:web" "npm:dev:app"` with a single
// Node process that owns the whole dev lifecycle. Two reasons:
//
//   1. Random port + random userData per run, so two concurrent
//      `npm run dev` shells don't collide on :4100 or SQLite WAL. Both
//      values are env vars, and concurrently can't share dynamic env
//      between siblings without a temp-file dance.
//
//   2. Guaranteed cleanup. Windows is unfriendly to "kill the whole
//      tree" via signals — `concurrently -k` does not reliably reach
//      electron's renderer / utility children. We spawn webpack and
//      electron directly here and `taskkill /F /T /PID` the recorded
//      PIDs on any exit path. Idempotent so SIGINT + exit don't
//      double-kill.
//
// Out of scope: Job Objects. Node has no native API, and the realistic
// failure case (force-kill of this orchestrator from outside, no exit
// hook fires) is covered by orphan-userData sweep on the next dev
// start.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

import {
  allocateDevPort,
  generateUserDataDirName,
  installCleanupTrap,
  reapOrphanUserDataDirs,
} from './dev-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const isWin = process.platform === 'win32';

// Sweep stragglers from previous runs that died via force-kill.
const reaped = reapOrphanUserDataDirs(repoRoot);
if (reaped.length > 0) {
  console.log(`[dev] reaped ${reaped.length} orphan userData dir(s): ${reaped.join(', ')}`);
}

const port = await allocateDevPort();
const userDataName = generateUserDataDirName();
const userDataDir = join(repoRoot, userDataName);
mkdirSync(userDataDir, { recursive: true });
console.log(`[dev] port=${port} userData=${userDataName}`);

const childEnv = {
  ...process.env,
  CCSM_DEV_PORT: String(port),
  CCSM_DEV_USERDATA: userDataDir,
};

// Windows: `npm` is `npm.cmd`, a batch shim — Node's spawn requires
// `shell: true` to invoke a .cmd / .bat (otherwise EINVAL). On POSIX
// we keep shell:false so the child gets its own process group and we
// can `kill(-pgid)` later for clean tree teardown.
const useShell = isWin;
const npmCmd = 'npm';

// `dev:web` — webpack-dev-server. It reads CCSM_DEV_PORT in webpack.config.js.
const webChild = spawn(npmCmd, ['run', 'dev:web'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: childEnv,
  shell: useShell,
  detached: !isWin,
});

// `dev:app` — wait for webpack to be ready, then compile TS + spawn
// electron via dev-electron.mjs. We keep the wait-on + tsc orchestration
// inside an npm script so anyone debugging can run `npm run dev:app`
// standalone with CCSM_DEV_PORT/CCSM_DEV_USERDATA set.
const appChild = spawn(npmCmd, ['run', 'dev:app'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: childEnv,
  shell: useShell,
  detached: !isWin,
});

const children = [webChild, appChild];

// If either child exits on its own, tear the rest down.
for (const c of children) {
  c.on('exit', (code, signal) => {
    console.log(`[dev] child pid=${c.pid} exited code=${code} signal=${signal}`);
    cleanup();
    process.exit(code ?? 0);
  });
}

function killPidTree(pid) {
  if (!pid) return;
  if (isWin) {
    // /T = kill the entire process tree (electron's renderer + utility).
    // /F = force. We don't care about the exit code — the process may
    // already be gone.
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } else {
    // Best-effort: SIGTERM the process group (negative pid). If we
    // weren't detached this falls back to the single pid.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    // Give it a beat, then SIGKILL if still around. We're in a
    // synchronous cleanup path, so just try-kill without waiting.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function cleanup() {
  for (const c of children) {
    try {
      killPidTree(c.pid);
    } catch {}
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Locked file (SQLite WAL on Windows occasionally) — leave for the
    // next-start orphan reaper.
  }
}

installCleanupTrap(cleanup);
