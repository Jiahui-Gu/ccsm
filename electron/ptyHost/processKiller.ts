// Single sink: terminate a process subtree rooted at `pid`.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A). ConPTY's
// kill only terminates the cmd.exe / OpenConsole wrapper; on Windows the
// claude.exe child (and its grandchildren) survive as orphans. On
// mac/linux the pgid may also have stragglers. This module walks the tree
// via a platform-native call to guarantee a clean shutdown. Best-effort —
// any already-dead pid is swallowed silently.
//
// Async contract: returns a Promise that resolves once the subtree-kill
// command has been dispatched (POSIX) or the spawned `taskkill` has exited
// or timed out (Windows). The Windows `taskkill` call blocks the OS for
// 200-2000ms per invocation; using async `spawn` (instead of `spawnSync`)
// lets callers fire N kills in parallel via `Promise.all` rather than
// serially blocking the main event loop for N × latency on quit — which
// previously froze the Electron UI during `before-quit` when several pty
// sessions were live.

import { spawn } from 'node:child_process';

// Hard ceiling on how long we wait for `taskkill` to exit before giving up
// and resolving the promise anyway. taskkill is "best-effort" itself — if
// it can't reap the tree in 5s it's almost certainly because something
// upstream is wedged, and we'd rather let app teardown continue than hang
// the UI forever on quit. The subtree kill signal has already been sent.
export const TASKKILL_TIMEOUT_MS = 5000;

export function killProcessSubtree(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      let child: ReturnType<typeof spawn>;
      try {
        // /T walks the entire tree, /F forces termination.
        child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // taskkill unavailable or arg-quoting blew up — nothing else we can
        // do; treat as already-dead and unblock the caller.
        resolve();
        return;
      }
      // 'error' fires if the binary couldn't be spawned (ENOENT etc.); 'exit'
      // fires on normal completion (success OR taskkill's non-zero "process
      // not found" exit). Either way we're done waiting.
      child.once('exit', done);
      child.once('error', done);
      timer = setTimeout(() => {
        // Wedged taskkill — abandon the wait so quit can proceed. The OS
        // kill signal has been dispatched; whatever process is leaking is
        // beyond our reach from here.
        try { child.kill(); } catch { /* ignore */ }
        done();
      }, TASKKILL_TIMEOUT_MS);
      // Don't keep the event loop alive for a stuck taskkill during quit.
      timer.unref?.();
    });
  }
  // POSIX: signal the process group (negative pid). SIGTERM first; SIGKILL
  // after a short grace period if anything refuses to exit. Both calls are
  // synchronous and non-blocking — we resolve immediately so callers can
  // fan out in parallel; the SIGKILL escalation lives on an unref'd timer
  // and runs independently of the returned promise.
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
