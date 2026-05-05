// Wave-2-C COMPAT SHIM: sessionWatcher physically moved to daemon/sessionWatcher/.
// This file remains so wave-1 dead callers (electron/ptyHost/* — itself
// dormant until W2-B mv's it into the daemon) keep typechecking.
//
// All methods are no-ops: PTY in wave-1 is not spawned by main.ts, so
// startWatching is never reached at runtime; the typecheck-only references
// are satisfied by an EventEmitter that simply never fires.
//
// DELETE this directory when W2-B mv's electron/ptyHost into daemon/ (the
// new in-daemon callers will import from `../sessionWatcher/` directly,
// and no electron-side caller will remain).

import { EventEmitter } from 'node:events';

class SessionWatcherStub extends EventEmitter {
  startWatching(_sid: string, _jsonlPath: string, _cwd?: string): void {}
  stopWatching(_sid: string): void {}
  closeAll(): void {}
  getLastEmittedForTest(_sid: string): unknown { return null; }
}

export const sessionWatcher = new SessionWatcherStub();

export type StateChangedEvent = { sid: string; state: 'idle' | 'running' };
export type TitleChangedEvent = { sid: string; title: string | null };
export type UnwatchedEvent = { sid: string };
