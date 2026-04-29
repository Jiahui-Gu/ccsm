// `title-changed` SINK.
//
// SRP: subscribe to FileSource ticks, ask the title bridge for the
// current SDK-derived summary, and emit when decideTitleEmit says yes.
// Owns per-sid `lastEmittedTitle` state.
//
// Knows nothing about: state classification, pendingRename flush, IPC.
// Calls into sessionTitles.getSessionTitle (this is the SOLE coupling
// from the watcher subsystem to the title subsystem on the title path —
// pendingRename has its own sink).

import { decideTitleEmit } from './emitDecider';
import type { FileTick } from './fileSource';

export interface TitleChangedPayload {
  sid: string;
  title: string;
}

export type TitleEmitter = (payload: TitleChangedPayload) => void;

/** Async fetcher injected at construction time so tests / different wiring
 *  can substitute. In production this is `getSessionTitle` from
 *  `electron/sessionTitles`. */
export type TitleFetcher = (
  sid: string,
  cwd?: string,
) => Promise<{ summary: string | null }>;

interface PerSid {
  lastEmittedTitle: string | null;
  closed: boolean;
}

export class TitleEmitterSink {
  private state = new Map<string, PerSid>();
  private fetchTitle: TitleFetcher;
  private emit: TitleEmitter;

  constructor(emit: TitleEmitter, fetchTitle: TitleFetcher) {
    this.emit = emit;
    this.fetchTitle = fetchTitle;
  }

  /** Feed a raw tick from FileSource. Skips when the file isn't on disk
   *  yet (the SDK call would always return null). */
  onTick(tick: FileTick, cwd?: string): void {
    if (!tick.fileExists) return;
    let entry = this.state.get(tick.sid);
    if (!entry) {
      entry = { lastEmittedTitle: null, closed: false };
      this.state.set(tick.sid, entry);
    }
    if (entry.closed) return;
    void this.maybeEmit(tick.sid, cwd, entry);
  }

  forget(sid: string): void {
    const entry = this.state.get(sid);
    if (entry) entry.closed = true;
    this.state.delete(sid);
  }

  private async maybeEmit(
    sid: string,
    cwd: string | undefined,
    entry: PerSid,
  ): Promise<void> {
    let summary: string | null = null;
    try {
      const result = await this.fetchTitle(sid, cwd);
      summary = result.summary;
    } catch {
      // Bridge swallows ENOENT internally; anything reaching here is
      // unexpected. Skip silently — the next tick will retry.
      return;
    }
    if (entry.closed) return;
    if (!decideTitleEmit(entry.lastEmittedTitle, summary)) return;
    // decideTitleEmit guarantees summary is a non-empty string when it
    // returns true.
    entry.lastEmittedTitle = summary;
    this.emit({ sid, title: summary as string });
  }
}
