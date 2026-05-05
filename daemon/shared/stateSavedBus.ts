// Tiny typed event bus for "a renderer-driven app_state row was successfully
// persisted". Producer: the `db:save` IPC handler in `electron/ipc/dbIpc.ts`.
// Consumers: prefs modules (e.g. crash reporting opt-out, notify-enabled) that
// hold an in-process cache of a single well-known key and need to invalidate
// when that key is rewritten.
//
// Why a bus instead of inline switch/case in dbIpc:
//   - Single Responsibility (per `feedback_single_responsibility.md`): the
//     db:save handler is a sink for the persistence side-effect; deciding
//     "which key invalidates which cache" is a per-cache concern owned by
//     the cache module itself, not the executor.
//   - Other subsystems' caches no longer have to be imported by the db layer.
//     Adding a new cached pref now means: (a) export an `invalidate*` and
//     (b) call `onStateSaved(...)` once from boot — zero edits to dbIpc.
//
// See `tech-debt-12-functional-core.md` leak #5.

import { EventEmitter } from 'node:events';

type SavedListener = (key: string) => void;

// Module-singleton emitter. Listeners are registered once at boot from the
// pref modules' `subscribe*Invalidation()` helpers; we don't expect a high
// fan-out, but bumping max listeners well above the default 10 keeps any
// future addition silent. 64 is arbitrary-but-generous.
const bus = new EventEmitter();
bus.setMaxListeners(64);

const SAVED = 'saved' as const;

/** Subscribe to "an app_state key was successfully written" events.
 *  Returns an unsubscribe function. Listener errors are logged but do NOT
 *  propagate to the producer (the db:save handler must still return ok to
 *  the renderer even if a downstream cache invalidator throws). */
export function onStateSaved(fn: SavedListener): () => void {
  const wrapped: SavedListener = (key) => {
    try {
      fn(key);
    } catch (err) {
      // Cache invalidation failure is non-fatal; log and continue so other
      // listeners still fire and the renderer still sees ok:true.
      console.error('[stateSavedBus] listener threw for key', key, err);
    }
  };
  bus.on(SAVED, wrapped);
  return () => {
    bus.off(SAVED, wrapped);
  };
}

/** Emit a "key was saved" event. Called by the db:save handler AFTER a
 *  successful sqlite write. Synchronous: listeners run on the same tick so
 *  cache invalidation is visible to the very next read. */
export function emitStateSaved(key: string): void {
  bus.emit(SAVED, key);
}

/** Test-only: drop all listeners so a test that mounts a fresh subscription
 *  isn't polluted by listeners registered by a sibling test. Not exported
 *  via index — call directly from tests. */
export function _resetStateSavedBusForTests(): void {
  bus.removeAllListeners(SAVED);
}
