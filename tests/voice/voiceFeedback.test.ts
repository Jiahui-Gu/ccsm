import { describe, it, expect } from 'vitest';
import {
  voiceToastForOutcome,
  formatElapsed,
  type VoiceOutcome,
} from '../../src/voice/voiceFeedback';

describe('voiceToastForOutcome', () => {
  it('no-speech → info toast with the "didn\'t catch that" copy', () => {
    expect(voiceToastForOutcome({ kind: 'no-speech' })).toEqual({
      kind: 'info',
      titleKey: 'voice.noSpeechTitle',
      bodyKey: 'voice.noSpeechBody',
    });
  });

  it('mic error → assertive error toast with recovery body', () => {
    expect(voiceToastForOutcome({ kind: 'error', message: 'mic' })).toEqual({
      kind: 'error',
      titleKey: 'voice.errorMic',
      bodyKey: 'voice.errorMicBody',
    });
  });

  it('no-model error → error toast pointing at the missing model', () => {
    expect(voiceToastForOutcome({ kind: 'error', message: 'no-model' })).toEqual({
      kind: 'error',
      titleKey: 'voice.errorNoModel',
      bodyKey: 'voice.errorNoModelBody',
    });
  });

  it('transcribe-failed → generic failure error toast', () => {
    expect(voiceToastForOutcome({ kind: 'error', message: 'transcribe-failed' })).toEqual({
      kind: 'error',
      titleKey: 'voice.errorFailed',
      bodyKey: 'voice.errorFailedBody',
    });
  });

  it('unknown error message falls back to the generic failure copy (never silent)', () => {
    const outcome: VoiceOutcome = { kind: 'error', message: 'some-future-code' };
    expect(voiceToastForOutcome(outcome)).toEqual({
      kind: 'error',
      titleKey: 'voice.errorFailed',
      bodyKey: 'voice.errorFailedBody',
    });
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute durations as 0:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(3)).toBe('0:03');
    expect(formatElapsed(59)).toBe('0:59');
  });

  it('rolls over into minutes', () => {
    expect(formatElapsed(60)).toBe('1:00');
    expect(formatElapsed(67)).toBe('1:07');
    expect(formatElapsed(125)).toBe('2:05');
  });

  it('floors fractional seconds and clamps negatives to 0:00', () => {
    expect(formatElapsed(3.9)).toBe('0:03');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});
