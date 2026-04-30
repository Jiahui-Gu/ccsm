// Sentry init wrapper. Extracted from electron/main.ts (Task #730 Phase A1).
//
// Crash reporting is OFF by default unless the operator plugs in a DSN
// via `SENTRY_DSN` at launch time. We intentionally do NOT ship a hardcoded
// project DSN in the open-source repo: self-hosters would otherwise send
// crashes to the maintainer's Sentry project with no opt-in. If you are
// building a fork, pass `SENTRY_DSN=https://...@your-project` to the app.
//
// `beforeSend` consults the user's opt-out preference at every send so the
// Settings toggle takes effect immediately (the cache is invalidated by the
// `db:save` IPC handler in main.ts when the renderer writes the key).

import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { loadCrashReportingOptOut } from '../prefs/crashReporting';

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim() || undefined;
  if (!dsn) {
    console.info('[sentry] SENTRY_DSN not set — crash reporting disabled.');
    return;
  }
  Sentry.init({
    dsn,
    release: app.getVersion(),
    environment: app.isPackaged ? 'prod' : 'dev',
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
