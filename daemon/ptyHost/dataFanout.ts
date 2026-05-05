// Module-level pty:data + pty:exit fan-out registry.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A); extended in
// W2-B (Task #581) with `onPtyChunk` (carries the per-entry monotonic seq for
// SSE clients) and `onPtyExit` so the daemon SSE endpoint can stream chunks
// + close the response when the underlying session ends without coupling
// `entryFactory.ts` to the HTTP transport.
//
// Subscribers:
//   * notify pipeline OSC sniffer (electron/notify/sinks/pipeline.ts) → uses
//     the legacy `onPtyData(sid, chunk)` signature (no seq dep).
//   * daemon/api/pty.ts SSE endpoint → uses `onPtyChunk(sid, chunk, seq)` +
//     `onPtyExit(sid, payload)`.
//
// Errors in subscribers are caught so a misbehaving sink cannot wedge the
// PTY.

export type PtyDataListener = (sid: string, chunk: string) => void;
export type PtyChunkListener = (sid: string, chunk: string, seq: number) => void;
export type PtyExitListener = (
  sid: string,
  payload: { code: number | null; signal: number | null },
) => void;

const dataListeners = new Set<PtyDataListener>();
const chunkListeners = new Set<PtyChunkListener>();
const exitListeners = new Set<PtyExitListener>();

/** Register a listener for every PTY chunk across all sessions. Returns an
 *  unsubscribe function. Idempotent — adding the same callback twice is
 *  silently deduped by Set semantics. */
export function onPtyData(cb: PtyDataListener): () => void {
  dataListeners.add(cb);
  return () => {
    dataListeners.delete(cb);
  };
}

/** seq-aware variant for SSE consumers. Same fan-out as `onPtyData`, just
 *  carries the per-entry monotonic chunk seq the renderer uses to dedupe
 *  against `getBufferSnapshot`. */
export function onPtyChunk(cb: PtyChunkListener): () => void {
  chunkListeners.add(cb);
  return () => {
    chunkListeners.delete(cb);
  };
}

/** Symmetric registration for PTY exit events. Used by `daemon/api/pty.ts` to
 *  close any open SSE response associated with the dead sid. */
export function onPtyExit(cb: PtyExitListener): () => void {
  exitListeners.add(cb);
  return () => {
    exitListeners.delete(cb);
  };
}

/** Fan out a chunk to every registered listener. Throws are caught and
 *  warned so a misbehaving sink cannot wedge the PTY. */
export function emitPtyData(sid: string, chunk: string, seq: number): void {
  for (const cb of dataListeners) {
    try {
      cb(sid, chunk);
    } catch (err) {
      console.warn('[ptyHost] data listener threw', err);
    }
  }
  for (const cb of chunkListeners) {
    try {
      cb(sid, chunk, seq);
    } catch (err) {
      console.warn('[ptyHost] chunk listener threw', err);
    }
  }
}

export function emitPtyExit(
  sid: string,
  payload: { code: number | null; signal: number | null },
): void {
  for (const cb of exitListeners) {
    try {
      cb(sid, payload);
    } catch (err) {
      console.warn('[ptyHost] exit listener threw', err);
    }
  }
}
