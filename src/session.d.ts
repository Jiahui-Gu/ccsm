// Renderer-side view of the `window.ccsmSession` preload bridge defined
// in `electron/preload/bridges/ccsmSession.ts`. The signal originates
// from the JSONL tail-watcher in `electron/sessionWatcher` and arrives
// over the `session:state` IPC channel as `{sid, state}`.
//
// State name semantics (mirrors the SDK's authoritative
// `SDKSessionStateChangedMessage.state` enum so we don't invent parallel
// vocabulary):
//   * 'idle'             — claude finished its turn, the user owes the next move.
//   * 'running'          — claude is mid-turn (tool call out, or user just typed).
//   * 'requires_action'  — claude paused on a permission prompt.
//
// The canonical type lives in `src/shared/sessionState.ts` and is shared
// with `electron/sessionWatcher/inference.ts` (`WatcherState` alias) and
// the preload bridge. We just re-export here so renderer call sites that
// already imported `from '../session'` keep working.
//
// Sidebar dot rules live in `src/components/Sidebar.tsx`. The notify
// integration (PR-B) will subscribe to the same signal.

export type { SessionState, SessionStatePayload } from './shared/sessionState';

export interface SessionTitlePayload {
  sid: string;
  title: string;
}

import type { SessionStatePayload } from './shared/sessionState';

export interface CcsmSessionApi {
  onState(cb: (e: SessionStatePayload) => void): () => void;
  onTitle?(cb: (e: SessionTitlePayload) => void): () => void;
}

declare global {
  interface Window {
    ccsmSession: CcsmSessionApi;
  }
}

export {};
