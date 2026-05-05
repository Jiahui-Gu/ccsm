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
// a module-scope variable after the first read. To stay consistent with the
// renderer Settings toggle without an app restart, the cache subscribes to
// the `stateSavedBus` (see `electron/shared/stateSavedBus.ts`) at boot:
// when `db:save` succeeds for our key, we drop the cache. Predicate ownership
// lives here, not in the db handler — see `tech-debt-12-functional-core.md`
// leak #5.

import { loadState } from '../db';
import { onStateSaved } from '../shared/stateSavedBus';

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
// from DB. Subscribed to the stateSavedBus from `subscribeCrashReportingInvalidation()`
// so the renderer's Settings toggle takes effect on the next error without
// an app restart.
export function invalidateCrashReportingCache(): void {
  _crashOptOutCached = undefined;
}

/** Wire the cache invalidation to the stateSavedBus. Call once during boot
 *  (before `registerDbIpc`). Returns the unsubscribe handle so tests can
 *  reverse-verify (and so a future hot-reload could detach). */
export function subscribeCrashReportingInvalidation(): () => void {
  return onStateSaved((key) => {
    if (key === CRASH_OPT_OUT_KEY) invalidateCrashReportingCache();
  });
}
