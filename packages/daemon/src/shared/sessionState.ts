// Canonical IPC `SessionState` vocabulary — daemon-side copy.
//
// Mirrors the SDK's authoritative `SDKSessionStateChangedMessage.state`
// enum so we don't invent parallel vocabulary:
//   * 'idle'             — claude finished its turn, the user owes the next move.
//   * 'running'          — claude is mid-turn (tool call out, or user just typed).
//   * 'requires_action'  — claude paused on a permission prompt.
//
// Lives under packages/daemon/src/shared/ because daemon's tsconfig
// `rootDir: src` forbids importing from the renderer's `src/shared/`.
// The renderer keeps its own copy at `src/shared/sessionState.ts`; the two
// must stay in sync until v0.4 unifies the wire vocabulary via Connect-RPC
// (then the daemon copy becomes authoritative and the renderer reads from
// the generated proto types).
//
// IMPORTANT: This is the IPC vocabulary, NOT the renderer's mapped UI
// state on `Session.state`. The mapping IPC → UI lives renderer-side in
// `src/agent/lifecycle.ts:mapState`. Don't conflate the two even though
// they share the `'idle'` literal.

export type SessionState = 'idle' | 'running' | 'requires_action';

export interface SessionStatePayload {
  sid: string;
  state: SessionState;
}
