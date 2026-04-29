// Crash reporting opt-out preference. Extracted from electron/main.ts
// (Task #730 Phase A1).
//
// Reads the user's opt-out preference for crash reporting from app_state.
// Returns false when the row is missing or the read errors — i.e. reporting
// is opt-OUT, default ON. We swallow errors here because Sentry's beforeSend
// is on the hot error path; failing closed (silently sending) is preferable
// to dropping a crash because the DB happened to be locked.
//
// Sentry's beforeSend runs on the hot error path, so we cache the value in
// a module-scope variable after the first read. The `db:save` handler in
// main.ts invalidates the cache when the renderer writes the key, so the
// toggle in Settings still takes effect immediately.

import { loadState } from '../db';

export const CRASH_OPT_OUT_KEY = 'crashReportingOptOut';

let _crashOptOutCached: boolean | undefined;

export function loadCrashReportingOptOut(): boolean {
  if (_crashOptOutCached !== undefined) return _crashOptOutCached;
  try {
    const raw = loadState(CRASH_OPT_OUT_KEY);
    const value = raw != null && (raw === 'true' || raw === '1');
    _crashOptOutCached = value;
    return value;
  } catch {
    return false;
  }
}

// Drop the cached value; the next `loadCrashReportingOptOut()` will re-read
// from DB. Called by the `db:save` IPC handler in main.ts when the renderer
// writes `crashReportingOptOut` so the Settings toggle takes effect on the
// next error without an app restart.
export function invalidateCrashReportingCache(): void {
  _crashOptOutCached = undefined;
}
