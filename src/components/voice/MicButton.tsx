import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { useToastOptional } from '../ui/Toast';
import { useVoiceRecorder } from './useVoiceRecorder';
import { formatElapsed, voiceToastForOutcome } from '../../voice/voiceFeedback';

// Mic toggle in the terminal corner. Targets the active session (sid).
// Idle → click to record; recording → click to stop; transcribing →
// disabled spinner; error → red, click resets. Injection (no Enter) is
// handled by the hook via pasteIntoActivePty.
//
// Feedback beyond the icon: no-speech / errors surface as toasts (with a
// reason + recovery hint), recording shows a live m:ss timer, and the
// transcribing state shows a visible "Transcribing…" label so the 1–2s
// cold start doesn't read as a hang. All motion is gated behind
// motion-reduce: for prefers-reduced-motion users.
export function MicButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const toast = useToastOptional();

  const { state, toggle } = useVoiceRecorder(sessionId, (outcome) => {
    const spec = voiceToastForOutcome(outcome);
    toast?.push({ kind: spec.kind, title: t(spec.titleKey), body: t(spec.bodyKey) });
  });

  // Recording duration: ticks once a second while recording, resets on stop.
  // Kept in component state (not the reducer) since it's pure presentation.
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.kind !== 'recording') {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      if (startedAt.current != null) {
        setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.kind]);

  const elapsedLabel = formatElapsed(elapsed);

  // aria-label describes the *current action* the button performs, so a
  // screen-reader user always knows what a click will do and what state
  // the recorder is in (color/animation alone is not enough — §1 color).
  const ariaLabel =
    state.kind === 'recording'
      ? t('voice.ariaStop', { time: elapsedLabel })
      : state.kind === 'transcribing'
        ? t('voice.ariaTranscribing')
        : state.kind === 'error'
          ? state.message === 'mic'
            ? t('voice.errorMic')
            : state.message === 'model-missing'
              ? t('voice.errorModelMissing')
              : state.message === 'bin-missing'
                ? t('voice.errorBinMissing')
                : t('voice.errorFailed')
          : t('voice.ariaStart');

  const color =
    state.kind === 'recording'
      ? 'text-red-400'
      : state.kind === 'error'
        ? 'text-red-500'
        : 'text-neutral-300';

  return (
    <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5">
      {/* Visible status pill — text + (for recording) a timer. Backs the
          icon's color/animation cue with a label so state changes aren't
          conveyed by color alone. */}
      {state.kind === 'recording' && (
        <span className="flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-red-300 tabular-nums">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse motion-reduce:animate-none"
          />
          {t('voice.recording')} {elapsedLabel}
        </span>
      )}
      {state.kind === 'transcribing' && (
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-neutral-200">
          {t('voice.transcribing')}
        </span>
      )}

      <button
        type="button"
        onClick={toggle}
        disabled={state.kind === 'transcribing'}
        aria-label={ariaLabel}
        aria-busy={state.kind === 'transcribing'}
        title={ariaLabel}
        className={`rounded p-1.5 bg-black/40 hover:bg-black/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-60 ${color}`}
      >
        {state.kind === 'transcribing' ? (
          <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />
        ) : state.kind === 'error' ? (
          <MicOff className="w-4 h-4" />
        ) : (
          <Mic
            className={`w-4 h-4 ${
              state.kind === 'recording' ? 'animate-pulse motion-reduce:animate-none' : ''
            }`}
          />
        )}
      </button>
    </div>
  );
}

export default MicButton;
