import { Mic, MicOff, Loader2 } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { useVoiceRecorder } from './useVoiceRecorder';

// Mic toggle in the terminal corner. Targets the active session (sid).
// Idle → click to record; recording → click to stop; transcribing →
// disabled spinner; error → red, click resets. Injection (no Enter) is
// handled by the hook via pasteIntoActivePty.
export function MicButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { state, toggle } = useVoiceRecorder(sessionId);

  const label =
    state.kind === 'recording'
      ? t('voice.stop')
      : state.kind === 'transcribing'
        ? t('voice.transcribing')
        : state.kind === 'error'
          ? state.message === 'mic'
            ? t('voice.errorMic')
            : state.message === 'no-model'
              ? t('voice.errorNoModel')
              : t('voice.errorFailed')
          : t('voice.start');

  const color =
    state.kind === 'recording'
      ? 'text-red-400'
      : state.kind === 'error'
        ? 'text-red-500'
        : 'text-neutral-300';

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={state.kind === 'transcribing'}
      aria-label={label}
      title={label}
      className={`absolute top-2 right-2 z-10 rounded p-1.5 bg-black/40 hover:bg-black/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-60 ${color}`}
    >
      {state.kind === 'transcribing' ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : state.kind === 'error' ? (
        <MicOff className="w-4 h-4" />
      ) : (
        <Mic className={`w-4 h-4 ${state.kind === 'recording' ? 'animate-pulse' : ''}`} />
      )}
    </button>
  );
}

export default MicButton;
