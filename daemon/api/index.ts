/**
 * Endpoint registry for the daemon HTTP API.
 *
 * Wave-1 (this PR): only the always-on endpoints `/api/health` and
 * `/api/version` registered from `daemon/main.ts`. This module is the
 * extension point — wave-2 deciders/sinks will register their endpoints by
 * calling `registerApi(router)` from here.
 */

import type { Router } from "../router";

/**
 * Register all wave-2+ API endpoints on the given router.
 *
 * Wave-1: intentionally empty. Wave-2 PRs will add route registrations here
 * (e.g. `router.addRoute("POST", "/api/sessions", createSession)`).
 */
export function registerApi(_router: Router): void {
  // Intentionally empty. Wave-2 dev fills in.
}
