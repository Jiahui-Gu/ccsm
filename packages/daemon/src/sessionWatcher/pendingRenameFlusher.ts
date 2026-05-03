// `pendingRename` flush SINK.
//
// SRP: subscribe to FileSource ticks, and the FIRST time a JSONL file is
// observed on disk for a sid, call the user-supplied `flush(sid)`. This
// is the ONE-shot edge trigger PR2 needs to drain queued user-set titles
// that arrived before the JSONL existed (renameSession would have thrown
// ENOENT pre-creation).
//
// Owns per-sid `jsonlSeen` flag. Knows nothing about classification, IPC,
// or the title bridge internals — just calls the injected flush callback.
//
// Why this is its own sink (and not part of stateEmitter):
//   * Different decision (decideFlushPending vs decideStateEmit).
//   * Different downstream (sessionTitles.flushPendingRename vs an
//     EventEmitter event).
//   * Originally lived inline in index.ts:330-340 and was the single
//     biggest SRP smell — the producer-classifier was reaching INTO the
//     title subsystem to flush a queue. Now it's a separate sink that
//     main.ts wires explicitly.

import { decideFlushPending } from './emitDecider.js';
import type { FileTick } from './fileSource.js';

export type PendingFlusher = (sid: string) => void | Promise<void>;

export class PendingRenameFlusherSink {
  private jsonlSeen = new Map<string, boolean>();
  private flush: PendingFlusher;

  constructor(flush: PendingFlusher) {
    this.flush = flush;
  }

  onTick(tick: FileTick): void {
    const seenBefore = this.jsonlSeen.get(tick.sid) ?? false;
    if (!decideFlushPending(seenBefore, tick.fileExists)) return;
    this.jsonlSeen.set(tick.sid, true);
    try {
      void this.flush(tick.sid);
    } catch (err) {
      console.warn(
        `[pendingRenameFlusher] flush(${tick.sid}) threw:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  forget(sid: string): void {
    this.jsonlSeen.delete(sid);
  }

  /** Replace the flush callback. Used at boot to wire production deps into
   *  a singleton constructed with a noop default — keeps the watcher
   *  module-graph free of any reverse import to sessionTitles. */
  setFlush(flush: PendingFlusher): void {
    this.flush = flush;
  }
}
