// Canonical IPC `SessionState` vocabulary — the single source of truth
// for the 3-state union emitted by `electron/sessionWatcher` and forwarded
// over the `session:state` IPC channel to the renderer (PR for tech-debt
// audit #10 item #2: SessionState was previously redeclared in 4+ places
// with already-present drift).
//
// Mirrors the SDK's authoritative `SDKSessionStateChangedMessage.state`
// enum so we don't invent parallel vocabulary:
//   * 'idle'             — claude finished its turn, the user owes the next move.
//   * 'running'          — claude is mid-turn (tool call out, or user just typed).
//   * 'requires_action'  — claude paused on a permission prompt.
//
// Lives under `src/shared/` because `tsconfig.electron.json` includes
// `src/shared/**/*` — both the renderer bundle (via `tsconfig.json`'s
// `src/**/*`) and the electron CJS compilation can import from this file
// without crossing tree boundaries.
//
// IMPORTANT: This is the IPC vocabulary, NOT the renderer's mapped UI
// state on `Session.state` (which is a 2-state `'idle' | 'waiting'`
// model — see `src/types.ts`). The mapping IPC → UI lives in
// `src/agent/lifecycle.ts:mapState`. Don't conflate the two even though
// they share the `'idle'` literal.

export type SessionState = 'idle' | 'running' | 'requires_action';

export interface SessionStatePayload {
  sid: string;
  state: SessionState;
}
