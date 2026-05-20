// Terminal scrollback line cap preference.
//
// Single user-facing knob that bounds BOTH the headless authoritative buffer
// (PR-A #861) and the per-attach `getBufferSnapshot` payload (PR-B #865).
// Lowered from the legacy 10000-line headless cap / 5000-line visible cap
// to a 1500-line default so a long-running session no longer pays MB-sized
// snapshot serialize cost on every attach.
//
// Persisted in app_state under `scrollbackLines`. Read synchronously inside
// `entryFactory.makeEntry` (when constructing the headless Terminal) and
// `lifecycle.attach` / `lifecycle.getBufferSnapshot` (when serializing) —
// the SQLite read is a single point lookup so the cost is negligible. The
// in-process cache + stateSavedBus invalidation pattern matches
// `notifyEnabled` and `crashReporting`: see tech-debt-12 leak #5.

import { loadState } from '../db';
import { onStateSaved } from '../shared/stateSavedBus';

export const SCROLLBACK_KEY = 'scrollbackLines';

/** Default cap. Applied when the row is missing or unparseable. */
export const DEFAULT_SCROLLBACK_LINES = 1500;

/** User-facing range. Anything outside this is clamped (not rejected) so a
 *  legacy snapshot with the old 5000/10000 value still loads sensibly. */
export const MIN_SCROLLBACK_LINES = 100;
export const MAX_SCROLLBACK_LINES = 50000;

let _cached: number | undefined;

/** Pure parser: clamp + integerize a raw persisted value into the valid
 *  range. Exported so the renderer setter can share the same sanitization. */
export function parseScrollbackLines(raw: unknown): number {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.length > 0) n = Number(raw);
  else return DEFAULT_SCROLLBACK_LINES;
  if (!Number.isFinite(n)) return DEFAULT_SCROLLBACK_LINES;
  n = Math.round(n);
  if (n < MIN_SCROLLBACK_LINES) return MIN_SCROLLBACK_LINES;
  if (n > MAX_SCROLLBACK_LINES) return MAX_SCROLLBACK_LINES;
  return n;
}

export function loadScrollbackLines(): number {
  if (_cached !== undefined) return _cached;
  try {
    const raw = loadState(SCROLLBACK_KEY);
    _cached = parseScrollbackLines(raw);
    return _cached;
  } catch {
    return DEFAULT_SCROLLBACK_LINES;
  }
}

export function invalidateScrollbackCache(): void {
  _cached = undefined;
}

/** Wire cache invalidation to the stateSavedBus. Call once during boot
 *  (before `registerDbIpc`). Returns the unsubscribe handle. */
export function subscribeScrollbackInvalidation(): () => void {
  return onStateSaved((key) => {
    if (key === SCROLLBACK_KEY) invalidateScrollbackCache();
  });
}
