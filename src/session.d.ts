// Renderer-side view of the `window.ccsmSession` preload bridge defined
// in `electron/preload.ts`. The signal originates from the JSONL
// tail-watcher in `electron/sessionWatcher` and arrives over the
// `session:state` IPC channel as `{sid, state}`.
//
// State name semantics (mirrors the SDK's authoritative
// `SDKSessionStateChangedMessage.state` enum so we don't invent parallel
// vocabulary):
//   * 'idle'             — claude finished its turn, the user owes the next move.
//   * 'running'          — claude is mid-turn (tool call out, or user just typed).
//   * 'requires_action'  — claude paused on a permission prompt.
//
// Sidebar dot rules live in `src/components/Sidebar.tsx`. The notify
// integration (PR-B) will subscribe to the same signal.

export type SessionState = 'idle' | 'running' | 'requires_action';

export interface SessionStatePayload {
  sid: string;
  state: SessionState;
}

export interface CcsmSessionApi {
  onState(cb: (e: SessionStatePayload) => void): () => void;
}

declare global {
  interface Window {
    ccsmSession: CcsmSessionApi;
  }
}

export {};
