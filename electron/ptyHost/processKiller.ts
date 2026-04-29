// Single sink: terminate a process subtree rooted at `pid`.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A). ConPTY's
// kill only terminates the cmd.exe / OpenConsole wrapper; on Windows the
// claude.exe child (and its grandchildren) survive as orphans. On
// mac/linux the pgid may also have stragglers. This module walks the tree
// via a platform-native call to guarantee a clean shutdown. Best-effort —
// any already-dead pid is swallowed silently.

import { spawnSync } from 'node:child_process';

export function killProcessSubtree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      // /T walks the entire tree, /F forces termination.
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* already dead or taskkill unavailable */
    }
    return;
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
}
