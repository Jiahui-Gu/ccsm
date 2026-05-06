/**
 * Startup module contracts.
 *
 * Wave 2 sub-PRs (W2-A/B/C) each need to wire something at daemon boot:
 * sentry init, sqlite open, ptyHost spawn, sessionWatcher start, notify
 * producer, etc. Without this registry they'd all edit `daemon/main.ts`
 * which makes them serial. Instead each drops a single file under
 * `daemon/startup/` exporting `default` as a `Startup` function.
 *
 * Modules run sequentially in alphabetical filename order.
 *
 * Two failure semantics (Task #639 — v0.3 ship-blocker):
 *
 *   * `critical: false` (default) — module throw is logged to stderr and
 *     the daemon keeps booting. Best-effort modules (sentry init,
 *     sessionTitles, notify pipeline) MUST stay non-critical so a single
 *     bad sub-module can't take the whole daemon down.
 *
 *   * `critical: true` — module throw is logged to stderr AND the daemon
 *     process exits non-zero BEFORE the HTTP server starts. The Electron
 *     host (electron/daemon-spawner.ts) sees the early exit, never gets a
 *     `PORT=<n>` line, and surfaces a hard-fail startup screen instead of
 *     creating the main app window. This is the ONLY way to guarantee
 *     "ready signal === all critical deps initialised" — which the
 *     dogfood-575 silent-data-loss P0 violated.
 *
 * To mark a module critical, attach the flag to the default export:
 *   const start: Startup = (ctx) => { ... };
 *   start.critical = true;
 *   export default start;
 *
 * Modules that need to register HTTP routes use `ctx.router`. Modules
 * that need to clean up on shutdown should listen for `ctx.abort` (fired
 * when SIGTERM/SIGINT arrives, before the HTTP server closes).
 */

import type { Router } from "../router";

export interface StartupContext {
  router: Router;
  version: string;
  abort: AbortSignal;
}

export interface Startup {
  (ctx: StartupContext): Promise<void> | void;
  /**
   * If true, a throw from this module is treated as a fatal startup
   * failure: daemon prints the stack to stderr and exits with code 1
   * BEFORE the HTTP server binds, so the parent Electron process never
   * sees a `PORT=<n>` line and surfaces a hard-fail startup screen.
   *
   * Default false: throw is logged + execution continues. See
   * daemon/startup/data.ts for the canonical critical=true module.
   */
  critical?: boolean;
}
