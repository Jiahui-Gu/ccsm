/**
 * Storage-health endpoint (Task #639 — v0.3 ship-blocker).
 *
 * Reports whether `initDb` succeeded at startup so the Electron host can
 * paint a fatal banner on top of the renderer when storage is broken
 * (better-sqlite3 ABI mismatch, EACCES on userdata dir, ENOSPC on the WAL
 * write, sqlite header corruption, or the `CCSM_TEST_BREAK_DB=1` test
 * seam). Cheap, no side effects — main polls it once after the daemon
 * spawns and stops; we don't bother with SSE because storage health at
 * this layer doesn't recover without a process restart.
 *
 * Wire format:
 *   GET /api/health/storage  →  200 { ok: true } | 200 { ok: false, reason: '...' }
 *
 * The 200 (not 503) is intentional: this endpoint is itself the health
 * probe, so the HTTP status reports "the probe ran" rather than "what it
 * found". Callers branch on `body.ok`.
 *
 * The catalog of db ops (db:save / db:load) DOES return non-2xx + reason
 * when storage is unhealthy — see `daemon/api/data.ts`. That's the path
 * that prevents silent saveState drops.
 */

import type { Router, HandlerResult } from '../router';
import { getStorageHealth } from '../db';

export default function register(router: Router): void {
  router.addRoute('GET', '/api/health/storage', (): HandlerResult => {
    const health = getStorageHealth();
    return { status: 200, body: health };
  });
}
