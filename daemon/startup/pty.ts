/**
 * Daemon startup hook for ptyHost — W2-B (Task #581).
 *
 * The ptyHost module is lazy: importing `daemon/ptyHost` does not spawn any
 * processes. Sessions are created on demand by `POST /api/pty/spawn`. The
 * one piece of boot-time wiring we DO need is a shutdown hook so SIGTERM /
 * SIGINT reaps every running pty before the daemon exits — without it the
 * `claude.exe` children survive as orphans on Windows (ConPTY's kill only
 * terminates the OpenConsole wrapper, not the actual CLI).
 *
 * `daemon/startup/index.ts` auto-discovers this module via filename and
 * invokes the default export with a `StartupContext`. We hook
 * `ctx.abort.addEventListener('abort', ...)` so the cleanup runs on the
 * same signal the HTTP server is shutting down on.
 */

import { killAllPtySessions } from "../ptyHost";
import type { Startup } from "./types";

const start: Startup = (ctx) => {
  // Idempotent — safe to invoke twice (e.g. SIGINT after SIGTERM).
  let drained = false;
  const drain = (): void => {
    if (drained) return;
    drained = true;
    try {
      killAllPtySessions();
      process.stderr.write("[daemon] ptyHost: drained on shutdown\n");
    } catch (err) {
      process.stderr.write(
        `[daemon] ptyHost drain failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  if (ctx.abort.aborted) {
    drain();
    return;
  }
  ctx.abort.addEventListener("abort", drain, { once: true });
};

export default start;
