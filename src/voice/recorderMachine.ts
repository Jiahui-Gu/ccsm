export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'error'; message: string };

export type VoiceAction =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'DONE' }
  | { type: 'FAIL'; message: string }
  | { type: 'RESET' };

// Pure transition function. Only one recording at a time app-wide:
// START is only honored from idle; STOP only from recording; the
// transcribing state rejects new starts so a slow transcribe can't
// overlap a fresh capture.
export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case 'START':
      return state.kind === 'idle' ? { kind: 'recording' } : state;
    case 'STOP':
      return state.kind === 'recording' ? { kind: 'transcribing' } : state;
    case 'DONE':
      return state.kind === 'transcribing' ? { kind: 'idle' } : state;
    case 'FAIL':
      return { kind: 'error', message: action.message };
    case 'RESET':
      return { kind: 'idle' };
    default:
      return state;
  }
}
