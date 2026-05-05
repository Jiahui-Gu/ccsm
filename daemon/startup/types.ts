/**
 * Startup module contracts.
 *
 * Wave 2 sub-PRs (W2-A/B/C) each need to wire something at daemon boot:
 * sentry init, sqlite open, ptyHost spawn, sessionWatcher start, notify
 * producer, etc. Without this registry they'd all edit `daemon/main.ts`
 * which makes them serial. Instead each drops a single file under
 * `daemon/startup/` exporting `default` as a `Startup` function.
 *
 * Modules run sequentially in alphabetical filename order. If one throws,
 * the daemon logs and continues — startup must be best-effort so a broken
 * sub-module can't take the whole daemon down.
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

export type Startup = (ctx: StartupContext) => Promise<void> | void;
