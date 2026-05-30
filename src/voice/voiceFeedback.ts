// Pure mapping from a voice-capture outcome to a toast spec. Kept separate
// from useVoiceRecorder so the "what to show the user" decision is a plain
// function we can unit-test without Web Audio, React, or the toast runtime.
//
// The hook owns the side effects (capture, transcribe, paste, dispatch); this
// module owns only the decision of which feedback (if any) to surface.

export type VoiceOutcome =
  | { kind: 'no-speech' } // clip too short or transcriber returned empty
  | { kind: 'error'; message: string }; // mic denied / no-model / transcribe-failed

export type VoiceToastSpec = {
  // Maps to ToastKind in components/ui/Toast.tsx. 'info' rides the polite
  // aria-live region; 'error' rides the assertive (role="alert") region.
  kind: 'info' | 'error';
  // i18n keys (namespace-qualified) — resolved by the caller via t().
  titleKey: string;
  bodyKey: string;
};

// Normalize the transcriber's error string into the three known buckets.
// Unknown messages fall back to the generic "transcription failed" copy so a
// user never gets a silent failure.
function errorKeys(message: string): { titleKey: string; bodyKey: string } {
  switch (message) {
    case 'mic':
      return { titleKey: 'voice.errorMic', bodyKey: 'voice.errorMicBody' };
    case 'no-model':
      return { titleKey: 'voice.errorNoModel', bodyKey: 'voice.errorNoModelBody' };
    default:
      return { titleKey: 'voice.errorFailed', bodyKey: 'voice.errorFailedBody' };
  }
}

export function voiceToastForOutcome(outcome: VoiceOutcome): VoiceToastSpec {
  if (outcome.kind === 'no-speech') {
    return {
      kind: 'info',
      titleKey: 'voice.noSpeechTitle',
      bodyKey: 'voice.noSpeechBody',
    };
  }
  const { titleKey, bodyKey } = errorKeys(outcome.message);
  return { kind: 'error', titleKey, bodyKey };
}

// Format an elapsed-seconds count as m:ss (e.g. 0:03, 1:07). Used for the
// recording-duration indicator and its aria-label.
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}
