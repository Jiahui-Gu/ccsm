// `state-changed` SINK.
//
// SRP: subscribe to FileSource ticks + (per-sid) call decideStateEmit, and
// when it returns true, call the user-supplied emit callback. Owns the
// per-sid `lastEmitted` state so the decider can stay pure.
//
// Knows nothing about: title derivation, pendingRename flush, IPC, notify,
// or the EventEmitter surface. Whoever wires it up provides `emit`.

import { classifyJsonlText, type WatcherState } from './inference.js';
import { decideStateEmit } from './emitDecider.js';
import type { FileTick } from './fileSource.js';

export interface StateChangedPayload {
  sid: string;
  state: WatcherState;
}

export type StateEmitter = (payload: StateChangedPayload) => void;

export class StateEmitterSink {
  private lastEmittedBySid = new Map<string, WatcherState>();
  private emit: StateEmitter;

  constructor(emit: StateEmitter) {
    this.emit = emit;
  }

  /** Feed a raw tick from FileSource. Idempotent; safe to drop ticks. */
  onTick(tick: FileTick): void {
    const next = classifyJsonlText(tick.text);
    const prev = this.lastEmittedBySid.get(tick.sid) ?? null;
    if (!decideStateEmit(prev, next)) return;
    this.lastEmittedBySid.set(tick.sid, next);
    this.emit({ sid: tick.sid, state: next });
  }

  /** Drop per-sid state when the session is unwatched. */
  forget(sid: string): void {
    this.lastEmittedBySid.delete(sid);
  }

  /** Test seam — reproduces the old `getLastEmittedForTest` surface. */
  getLastEmitted(sid: string): WatcherState | null {
    return this.lastEmittedBySid.get(sid) ?? null;
  }
}
