// Single sink: terminate a process subtree rooted at `pid`.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A). ConPTY's
// kill only terminates the cmd.exe / OpenConsole wrapper; on Windows the
// claude.exe child (and its grandchildren) survive as orphans. On
// mac/linux the pgid may also have stragglers. This module walks the tree
// via a platform-native call to guarantee a clean shutdown. Best-effort —
// any already-dead pid is swallowed silently.
//
// Returns Promise<void> on BOTH platforms (#1380): the historical
// Windows implementation used `spawnSync('taskkill',...)`, which blocks
// the Electron main thread for 200–2000 ms per pid (Defender scan + WMI
// roundtrip for /T tree walk). Quit-time `killAllPtySessions()` fans out
// `kill()` in parallel, but on the wedged-fallback branch every per-
// session 3s timer eventually called `killProcessSubtree`, so N sessions
// produced N serial sync calls on the main thread → multi-second UI
// freeze on quit. Now async: `spawn` + 'close' event + 5s ceiling fed by
// `child.kill()` last-ditch, so the main thread never blocks regardless
// of how many sessions need to reap.
//
// POSIX returns Promise<void> for the same uniform shape, but resolves
// immediately — the SIGTERM-then-SIGKILL escalation already ran on
// timers under the hood (and the SIGKILL fallback fires via
// `setTimeout(...).unref()` 500 ms later regardless of whether the
// caller awaits us).

import { spawn } from 'node:child_process';

/** Hard ceiling on how long we'll wait for `taskkill /F /T` to finish
 *  before declaring it wedged. taskkill is normally <500 ms even with
 *  Defender in the loop; 5 s is generous enough to absorb a contended
 *  Windows host while keeping quit responsive. */
export const TASKKILL_TIMEOUT_MS = 5000;

export function killProcessSubtree(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      let child: ReturnType<typeof spawn>;
      try {
        // /T walks the entire tree, /F forces termination. `windowsHide`
        // prevents a console flash; `stdio:'ignore'` discards taskkill's
        // status lines (we already swallow non-zero exits because dead
        // pids are expected).
        child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        /* taskkill unavailable on PATH — nothing more we can do. */
        resolve();
        return;
      }
      child.once('close', settle);
      child.once('error', settle);
      // Last-ditch: a 5s wedged taskkill (rare: usually means Defender
      // is mid-scan or WMI is hung) gets SIGKILL'd so we don't strand
      // the main quit path waiting on it. The orphan tree may survive
      // until the OS reaps it on logout, but the app exits cleanly.
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* taskkill already exited between the timer firing and
             child.kill() landing */
        }
        settle();
      }, TASKKILL_TIMEOUT_MS);
      // Don't keep the event loop alive purely to wait for taskkill —
      // the surrounding quit path resolves the Promise either way.
      timer.unref?.();
    });
  }
  // POSIX: signal the process group (negative pid). SIGTERM first; SIGKILL
  // after a short grace period if anything refuses to exit.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* group already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }, 500).unref();
  return Promise.resolve();
}
