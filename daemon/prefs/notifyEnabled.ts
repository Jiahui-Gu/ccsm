// Notification mute preference. Extracted from electron/main.ts (Task #730
// Phase A1).
//
// Persisted in app_state under `notifyEnabled` (default true → notifications
// on). Cached in main-process memory so the per-event check in the notify
// bridge stays cheap; the cache subscribes to the `stateSavedBus`
// (see `electron/shared/stateSavedBus.ts`) so writes from the renderer
// (db:save) invalidate it without an app restart. Predicate ownership lives
// here — see `tech-debt-12-functional-core.md` leak #5.

import { loadState } from '../db';
import { onStateSaved } from '../shared/stateSavedBus';

export const NOTIFY_ENABLED_KEY = 'notifyEnabled';

let _notifyEnabledCached: boolean | undefined;

export function loadNotifyEnabled(): boolean {
  if (_notifyEnabledCached !== undefined) return _notifyEnabledCached;
  try {
    const raw = loadState(NOTIFY_ENABLED_KEY);
    // Default ON: missing row OR any non-explicit-off value → notifications fire.
    const value = raw == null ? true : !(raw === 'false' || raw === '0');
    _notifyEnabledCached = value;
    return value;
  } catch {
    return true;
  }
}

// Drop the cached value; the next `loadNotifyEnabled()` will re-read from DB.
// Subscribed to the stateSavedBus from `subscribeNotifyEnabledInvalidation()`
// so the renderer's Settings toggle takes effect immediately.
export function invalidateNotifyEnabledCache(): void {
  _notifyEnabledCached = undefined;
}

/** Wire the cache invalidation to the stateSavedBus. Call once during boot
 *  (before `registerDbIpc`). Returns the unsubscribe handle. */
export function subscribeNotifyEnabledInvalidation(): () => void {
  return onStateSaved((key) => {
    if (key === NOTIFY_ENABLED_KEY) invalidateNotifyEnabledCache();
  });
}
