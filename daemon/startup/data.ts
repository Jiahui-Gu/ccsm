/**
 * Wave-2 A startup hook. Auto-loaded by daemon/startup/index.ts.
 *
 * Marked `critical: true` (Task #639): if `initDb` throws (better-sqlite3
 * ABI mismatch / EACCES on userdata dir / ENOSPC / sqlite header
 * corruption / `CCSM_TEST_BREAK_DB=1` test seam), runStartup will exit
 * the daemon process with code 1 BEFORE the HTTP server binds. The
 * Electron host then sees no PORT line + non-zero exit and surfaces a
 * hard-fail startup screen instead of creating the main window. This is
 * the v0.3 ship-blocker fix for the dogfood-575 silent-data-loss P0:
 * previously initDb failure was caught + logged, daemon kept printing
 * PORT, the renderer mounted, every db:save returned silent failure and
 * users lost all their work on restart.
 *
 * `markStorageUnhealthy` is still imported + reachable from runtime db
 * ops (db.ts saveState catch path) so a SQLITE_FULL / SQLITE_IOERR that
 * happens AFTER startup still surfaces a banner. Startup-time failure
 * is the new hard-fail path.
 *
 * Responsibilities:
 *   1. Init Sentry (no-op if SENTRY_DSN is unset). Must run before
 *      anything can throw an unhandled rejection so crashes are captured.
 *   2. Open the SQLite database eagerly. Throw is fatal — see above.
 *   3. Wire the prefs cache invalidations to the stateSavedBus so renderer
 *      Settings toggles take effect on the next read without an app restart.
 *   4. Close the DB cleanly on shutdown.
 */

import type { StartupContext, Startup } from './types';
import { initSentry } from '../sentry/init';
import { initDb, closeDb } from '../db';
import { subscribeNotifyEnabledInvalidation } from '../prefs/notifyEnabled';
import { subscribeCrashReportingInvalidation } from '../prefs/crashReporting';

const start: Startup = function start(ctx: StartupContext): void {
  // (1) Sentry first so unhandled errors during the rest of startup are
  //     captured. No-op when SENTRY_DSN is unset, so this is safe in dev.
  initSentry();

  // (2) Eager db open. Throw propagates up to runStartup which prints a
  //     FATAL banner + exits 1 — this module is critical=true. Parent
  //     Electron sees the early exit, never gets a PORT line, surfaces
  //     the hard-fail startup screen.
  initDb();

  // (3) Cache invalidation subscriptions. Each subscribe* returns an
  //     unsubscribe handle; we wire them to the abort signal so a
  //     hot-restart (future capability) doesn't leak listeners.
  const unsubNotify = subscribeNotifyEnabledInvalidation();
  const unsubCrash = subscribeCrashReportingInvalidation();

  // (4) Shutdown hook. AbortSignal.addEventListener('abort') fires
  //     synchronously when SIGTERM/SIGINT triggers main's AbortController.
  //     Order: drop bus listeners → close db. Closing db drains the WAL.
  ctx.abort.addEventListener(
    'abort',
    () => {
      try {
        unsubNotify();
        unsubCrash();
      } catch (err) {
        process.stderr.write(
          `[startup-data] unsubscribe failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      try {
        closeDb();
      } catch (err) {
        process.stderr.write(
          `[startup-data] closeDb failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
    { once: true },
  );
};

start.critical = true;

export default start;
