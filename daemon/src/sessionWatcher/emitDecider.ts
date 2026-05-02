// Pure decision functions for session-event emit gating (daemon-side).
//
// Task #106. Mirror of `electron/sessionWatcher/emitDecider.ts`. Pure
// functions, no I/O — callers own state.

import type { WatcherState } from './inference.js';

/** True when the new state differs from the last emitted state (or no
 *  prior state was emitted). */
export function decideStateEmit(
  prev: WatcherState | null,
  next: WatcherState,
): boolean {
  return next !== prev;
}

/** True when the SDK-derived summary is a real, non-empty string AND
 *  differs from the last one we emitted. */
export function decideTitleEmit(
  prev: string | null,
  next: string | null,
): boolean {
  if (typeof next !== 'string' || next.length === 0) return false;
  return next !== prev;
}
