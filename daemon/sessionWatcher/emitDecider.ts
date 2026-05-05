// Pure decision functions for sessionWatcher emit gating.
//
// SRP: this module is a DECIDER only. No I/O, no state, no side effects.
// Callers own state and feed prev/next snapshots in; the decider answers
// boolean "should I emit?". Splits out the inline `if (next !== prev)`
// dedupe checks that previously lived inline in the producer/sink mix in
// `index.ts`.
//
// Decision table:
//
//   | function              | input                                     | true when                                                    |
//   |-----------------------|-------------------------------------------|--------------------------------------------------------------|
//   | decideStateEmit       | prev: WatcherState\|null, next: WatcherState | next !== prev (1-line dedupe; null prev = first emission) |
//   | decideTitleEmit       | prev: string\|null, next: string\|null    | next is non-empty string AND next !== prev                   |
//   | decideFlushPending    | jsonlSeenBefore: boolean, fileExists: bool | fileExists AND !jsonlSeenBefore (one-shot edge trigger)     |
//
// Companion to `inference.ts` (also pure, classifies JSONL → state).
// Together these cover every decision the watcher subsystem makes.

import type { WatcherState } from './inference';

/** True when the new state differs from the last emitted state (or no
 *  prior state was emitted). One-line dedupe, extracted so the call site
 *  doesn't have to know the prev/next semantics. */
export function decideStateEmit(
  prev: WatcherState | null,
  next: WatcherState,
): boolean {
  return next !== prev;
}

/** True when the SDK-derived summary is a real, non-empty string AND
 *  differs from the last one we emitted. Both null and '' are skipped —
 *  the renderer should keep its existing name until the SDK has something
 *  real (matches the original inline check in index.ts:366-367). */
export function decideTitleEmit(
  prev: string | null,
  next: string | null,
): boolean {
  if (typeof next !== 'string' || next.length === 0) return false;
  return next !== prev;
}

/** True on the one tick where the JSONL file first appears on disk. The
 *  caller flips its `jsonlSeen` flag the moment this returns true so we
 *  fire flushPendingRename exactly once per session lifetime. */
export function decideFlushPending(
  jsonlSeenBefore: boolean,
  fileExists: boolean,
): boolean {
  return fileExists && !jsonlSeenBefore;
}
