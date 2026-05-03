// Module-level pty:data fan-out registry.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A). Subscribers
// (currently only the notify pipeline's OSC sniffer in
// electron/notify/sinks/pipeline.ts) register here to receive every PTY
// chunk for every session. The per-session `p.onData` callback in
// `makeEntry` calls `emitPtyData` for each chunk. Errors in subscribers
// are caught so a misbehaving sink cannot wedge the PTY.

export type PtyDataListener = (sid: string, chunk: string) => void;

const dataListeners = new Set<PtyDataListener>();

/** Register a listener for every PTY chunk across all sessions. Returns an
 *  unsubscribe function. Idempotent — adding the same callback twice is
 *  silently deduped by Set semantics. */
export function onPtyData(cb: PtyDataListener): () => void {
  dataListeners.add(cb);
  return () => {
    dataListeners.delete(cb);
  };
}

/** Fan out a chunk to every registered listener. Throws are caught and
 *  warned so a misbehaving sink cannot wedge the PTY. */
export function emitPtyData(sid: string, chunk: string): void {
  for (const cb of dataListeners) {
    try {
      cb(sid, chunk);
    } catch (err) {
      console.warn('[ptyHost] data listener threw', err);
    }
  }
}
