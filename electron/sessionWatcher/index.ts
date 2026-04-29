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
//
// Module-graph SRP (#690 follow-up to #536): this file used to import
// `getSessionTitle` and `flushPendingRename` from `../sessionTitles` to
// supply the singleton's defaults. That left a reverse import edge
// (sessionWatcher → sessionTitles) even though the runtime SRP was
// clean. Now the singleton boots with noop defaults and main.ts wires
// the real callbacks via `configureSessionWatcher` at startup. Result:
// zero `from '../sessionTitles'` imports anywhere under sessionWatcher/.

import { EventEmitter } from 'node:events';
import { FileSource, type FileTick } from './fileSource';
import { StateEmitterSink, type StateChangedPayload } from './stateEmitter';
import { TitleEmitterSink, type TitleChangedPayload, type TitleFetcher } from './titleEmitter';
import { PendingRenameFlusherSink, type PendingFlusher } from './pendingRenameFlusher';
import type { WatcherState } from './inference';

export type { WatcherState } from './inference';
export type { TitleFetcher } from './titleEmitter';
export type { PendingFlusher } from './pendingRenameFlusher';

export interface StateChangedEvent extends StateChangedPayload {}
export interface TitleChangedEvent extends TitleChangedPayload {}
export interface UnwatchedEvent { sid: string }

// Default title fetcher: returns null so TitleEmitterSink emits nothing.
// Production wires the real `getSessionTitle` via `configureSessionWatcher`
// at boot (called from main.ts). Tests inject explicitly via __createForTest.
const noopFetchTitle: TitleFetcher = async () => ({ summary: null });

// Default pending-rename flusher: no-op. Production wires the real
// `flushPendingRename` via `configureSessionWatcher` at boot.
const noopFlushRename: PendingFlusher = () => {};

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
    const fetchTitle: TitleFetcher = opts?.fetchTitle ?? noopFetchTitle;
    const flushRename: PendingFlusher = opts?.flushRename ?? noopFlushRename;

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

  /** Wire production callbacks into the singleton at boot. The singleton
   *  is constructed at module-load with noop defaults so that the
   *  sessionWatcher subsystem has zero reverse imports to sessionTitles;
   *  main.ts calls this once during boot before any sessions launch. */
  configure(opts: { fetchTitle?: TitleFetcher; flushRename?: PendingFlusher }): void {
    if (opts.fetchTitle) this.titleSink.setFetcher(opts.fetchTitle);
    if (opts.flushRename) this.flusherSink.setFlush(opts.flushRename);
  }
}

// Module-level singleton — main.ts wires one IPC fan-out off this
// emitter and ptyHost calls start/stopWatching directly.
export const sessionWatcher = new SessionWatcher();

/** Wire the singleton's production callbacks. Called once from main.ts
 *  during boot — must run before any session starts so the very first
 *  JSONL tick has the real flusher in place. */
export function configureSessionWatcher(opts: {
  fetchTitle?: TitleFetcher;
  flushRename?: PendingFlusher;
}): void {
  sessionWatcher.configure(opts);
}

// Test factory — fresh instance per test, no shared state.
export function __createForTest(opts?: {
  fetchTitle?: TitleFetcher;
  flushRename?: PendingFlusher;
}): SessionWatcher {
  return new SessionWatcher(opts);
}

export type { SessionWatcher };
