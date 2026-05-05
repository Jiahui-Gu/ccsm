/**
 * Wave-2 A startup hook. Auto-loaded by daemon/startup/index.ts.
 *
 * Responsibilities:
 *   1. Init Sentry (no-op if SENTRY_DSN is unset). Must run before anything
 *      can throw an unhandled rejection so crashes are captured.
 *   2. Open the SQLite database eagerly. The first IPC handler that touches
 *      `loadState` would open it lazily anyway, but pre-warming surfaces a
 *      corrupt-file recovery (ensureHealthyDb) at boot rather than at first
 *      renderer interaction. Failures here are logged but non-fatal — the
 *      daemon keeps running so non-db endpoints (sessionTitles, import)
 *      still work.
 *   3. Wire the prefs cache invalidations to the stateSavedBus so renderer
 *      Settings toggles take effect on the next read without an app restart.
 *      Mirrors the legacy electron-side `subscribeNotifyEnabledInvalidation`
 *      / `subscribeCrashReportingInvalidation` boot calls.
 *   4. Close the DB cleanly on shutdown. The host (electron) sends SIGTERM
 *      → main.ts fires AbortController.abort → ctx.abort.aborted becomes
 *      true and our listener flushes WAL + closes the handle.
 */

import type { StartupContext } from './types';
import { initSentry } from '../sentry/init';
import { initDb, closeDb } from '../db';
import { subscribeNotifyEnabledInvalidation } from '../prefs/notifyEnabled';
import { subscribeCrashReportingInvalidation } from '../prefs/crashReporting';

export default function start(ctx: StartupContext): void {
  // (1) Sentry first so unhandled errors during the rest of startup are
  //     captured. No-op when SENTRY_DSN is unset, so this is safe in dev.
  initSentry();

  // (2) Eager db open. Surfaces corrupt-file recovery + WAL journal_mode
  //     pragma at boot, not at first renderer call. Failures are logged
  //     and swallowed so the daemon's non-db surfaces (sessionTitles,
  //     import) still come up.
  try {
    initDb();
  } catch (err) {
    process.stderr.write(
      `[startup-data] initDb failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

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
}
