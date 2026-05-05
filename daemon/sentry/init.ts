// Sentry init wrapper. Wave-2 A: moved from electron/sentry/init.ts into
// daemon/sentry/init.ts. The daemon is a plain Node process so we use
// `@sentry/node` instead of `@sentry/electron/main`, and read the app
// version + packaged flag from env vars (CCSM_APP_VERSION, CCSM_IS_PACKAGED)
// that electron's daemon-spawner injects. The renderer-side Sentry preload
// is independent and unaffected.
//
// Crash reporting is OFF by default unless the operator plugs in a DSN
// via `SENTRY_DSN` at launch time. We intentionally do NOT ship a hardcoded
// project DSN in the open-source repo: self-hosters would otherwise send
// crashes to the maintainer's Sentry project with no opt-in. If you are
// building a fork, pass `SENTRY_DSN=https://...@your-project` to the app.
//
// `beforeSend` consults the user's opt-out preference at every send so the
// Settings toggle takes effect immediately (the cache is invalidated by the
// `db:save` HTTP endpoint in daemon/api/data.ts when the renderer writes
// the key, via the stateSavedBus subscription registered at startup).

import * as Sentry from '@sentry/node';
import { loadCrashReportingOptOut } from '../prefs/crashReporting';

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim() || undefined;
  if (!dsn) {
    // stderr (NOT stdout) — daemon's stdout protocol reserves the first
    // line for `PORT=<n>` and main.ts's daemon-spawner rejects any other
    // first line. console.info defaults to stdout; use process.stderr
    // explicitly so this status log can't ever break the spawn handshake.
    process.stderr.write('[sentry] SENTRY_DSN not set — crash reporting disabled.\n');
    return;
  }
  const release = process.env.CCSM_APP_VERSION?.trim() || '0.0.0';
  const isPackaged = process.env.CCSM_IS_PACKAGED === '1';
  Sentry.init({
    dsn,
    release,
    environment: isPackaged ? 'prod' : 'dev',
    sendDefaultPii: false,
    beforeSend(event) {
      try {
        const optOut = loadCrashReportingOptOut();
        if (optOut) return null;
      } catch {
        /* fall through, send anyway */
      }
      return event;
    },
  });
}
