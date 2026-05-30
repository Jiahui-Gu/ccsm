import { describe, it, expect } from 'vitest';
import { voiceReducer, type VoiceState } from '../../src/voice/recorderMachine';

const idle: VoiceState = { kind: 'idle' };

describe('voiceReducer', () => {
  it('idle + START → recording', () => {
    expect(voiceReducer(idle, { type: 'START' })).toEqual({ kind: 'recording' });
  });
  it('recording + STOP → transcribing', () => {
    expect(voiceReducer({ kind: 'recording' }, { type: 'STOP' })).toEqual({
      kind: 'transcribing',
    });
  });
  it('transcribing + DONE → idle', () => {
    expect(voiceReducer({ kind: 'transcribing' }, { type: 'DONE' })).toEqual(idle);
  });
  it('transcribing + FAIL → error', () => {
    expect(voiceReducer({ kind: 'transcribing' }, { type: 'FAIL', message: 'x' })).toEqual({
      kind: 'error',
      message: 'x',
    });
  });
  it('recording + FAIL (mic denied) → error', () => {
    expect(voiceReducer({ kind: 'recording' }, { type: 'FAIL', message: 'mic' })).toEqual({
      kind: 'error',
      message: 'mic',
    });
  });
  it('error + RESET → idle', () => {
    expect(voiceReducer({ kind: 'error', message: 'x' }, { type: 'RESET' })).toEqual(idle);
  });
  it('ignores START while transcribing (no concurrent record)', () => {
    const s: VoiceState = { kind: 'transcribing' };
    expect(voiceReducer(s, { type: 'START' })).toEqual(s);
  });
});
