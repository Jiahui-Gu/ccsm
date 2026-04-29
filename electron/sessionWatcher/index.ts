// Per-session JSONL tail-watcher — FACADE.
//
// SRP refactor (#678 / per #677 evaluation): the old monolithic
// implementation here was producer + decider + sink in one class. It now
// composes four single-responsibility modules:
//
//   FileSource              (./fileSource)              — producer (fs.watch)
//   classifyJsonlText       (./inference)               — decider (text → state)
//   decideStateEmit/Title/  (./emitDecider)             — decider (gate emits)
//     FlushPending
//   StateEmitterSink        (./stateEmitter)            — sink: state-changed
//   TitleEmitterSink        (./titleEmitter)            — sink: title-changed
//   PendingRenameFlusherSink (./pendingRenameFlusher)   — sink: drain rename queue
//
// This file keeps the legacy `EventEmitter`-based surface alive so
// existing callers (main.ts, ptyHost, notify, tests) can keep using
// `sessionWatcher.on('state-changed' | 'title-changed' | 'unwatched')`
// and `startWatching/stopWatching/closeAll/getLastEmittedForTest`
// unchanged. Internally everything routes through the four modules
// above.
//
// Why keep the facade rather than rip it out: 17 callers across electron
// + tests + harness reference the singleton or the type. Touching them
// all would balloon the diff far beyond the SRP point. The facade is
// thin (~80 lines) and exists only as wiring; the real logic now lives
// in the dedicated modules.

import { EventEmitter } from 'node:events';
import { FileSource, type FileTick } from './fileSource';
import { StateEmitterSink, type StateChangedPayload } from './stateEmitter';
import { TitleEmitterSink, type TitleChangedPayload, type TitleFetcher } from './titleEmitter';
import { PendingRenameFlusherSink, type PendingFlusher } from './pendingRenameFlusher';
import { getSessionTitle, flushPendingRename } from '../sessionTitles';
import type { WatcherState } from './inference';

export type { WatcherState } from './inference';

export interface StateChangedEvent extends StateChangedPayload {}
export interface TitleChangedEvent extends TitleChangedPayload {}
export interface UnwatchedEvent { sid: string }

class SessionWatcher extends EventEmitter {
  private source: FileSource;
  private stateSink: StateEmitterSink;
  private titleSink: TitleEmitterSink;
  private flusherSink: PendingRenameFlusherSink;

  constructor(opts?: {
    fetchTitle?: TitleFetcher;
    flushRename?: PendingFlusher;
  }) {
    super();
    const fetchTitle: TitleFetcher = opts?.fetchTitle ?? getSessionTitle;
    const flushRename: PendingFlusher = opts?.flushRename ?? flushPendingRename;

    this.stateSink = new StateEmitterSink((payload) => {
      this.emit('state-changed', payload);
    });
    this.titleSink = new TitleEmitterSink((payload) => {
      this.emit('title-changed', payload);
    }, fetchTitle);
    this.flusherSink = new PendingRenameFlusherSink(flushRename);

    // Assembly order: sinks are constructed FIRST, then bound to the
    // producer. Critical: the pendingRename flusher must be subscribed
    // before the very first tick so the very first JSONL appearance for
    // any sid is not missed (otherwise queued user-set renames would
    // never drain). FileSource.start fires the initial read on a 0-ms
    // setTimeout, so the binding below — which runs synchronously before
    // start returns — wins the race.
    this.source = new FileSource((tick: FileTick) => {
      this.flusherSink.onTick(tick);
      this.stateSink.onTick(tick);
      this.titleSink.onTick(tick, this.source?.getCwd(tick.sid));
    });
  }

  startWatching(sid: string, jsonlPath: string, cwd?: string): void {
    this.source.start(sid, jsonlPath, cwd);
  }

  stopWatching(sid: string): void {
    const wasTracked = this.source.stop(sid);
    if (!wasTracked) return;
    this.stateSink.forget(sid);
    this.titleSink.forget(sid);
    this.flusherSink.forget(sid);
    // Signal session teardown so other main-process state keyed by sid
    // can drop its entry. titleStateBridge subscribes to this.
    this.emit('unwatched', { sid } as UnwatchedEvent);
  }

  closeAll(): void {
    const sids = this.source.sids();
    for (const sid of sids) this.stopWatching(sid);
  }

  getLastEmittedForTest(sid: string): WatcherState | null {
    return this.stateSink.getLastEmitted(sid);
  }
}

// Module-level singleton — main.ts wires one IPC fan-out off this
// emitter and ptyHost calls start/stopWatching directly.
export const sessionWatcher = new SessionWatcher();

// Test factory — fresh instance per test, no shared state.
export function __createForTest(opts?: {
  fetchTitle?: TitleFetcher;
  flushRename?: PendingFlusher;
}): SessionWatcher {
  return new SessionWatcher(opts);
}

export type { SessionWatcher };
