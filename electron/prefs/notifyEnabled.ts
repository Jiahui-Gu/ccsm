// Notification mute preference. Extracted from electron/main.ts (Task #730
// Phase A1).
//
// Persisted in app_state under `notifyEnabled` (default true → notifications
// on). Cached in main-process memory so the per-event check in the notify
// bridge stays cheap; the `db:save` handler invalidates the cache when the
// renderer writes the key so the Settings toggle takes effect without a
// restart. Mirrors the `closeAction` / `crashReportingOptOut` patterns.

import { loadState } from '../db';

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
// Called by the `db:save` IPC handler in main.ts when the renderer writes
// `notifyEnabled` so the Settings toggle takes effect immediately.
export function invalidateNotifyEnabledCache(): void {
  _notifyEnabledCached = undefined;
}
