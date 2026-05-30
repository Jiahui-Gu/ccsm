import { useCallback, useReducer, useRef } from 'react';
import { voiceReducer, type VoiceState } from '../../voice/recorderMachine';
import type { VoiceOutcome } from '../../voice/voiceFeedback';
import { resampleTo16k } from '../../voice/resample';
import { getTopShell } from '../../terminal/shellRegistry';
import { pasteIntoActivePty } from '../../terminal/paste';

const MIN_SAMPLES_16K = 16000 * 0.3; // ~300ms; shorter clips are treated as silence

// Owns Web Audio capture + the transcription/injection flow. The button
// targets the active session (sid passed in by the hosting TerminalPane),
// matching how paste resolves its target via getTopShell().
//
// `onFeedback` surfaces user-visible outcomes (no speech / errors) without
// coupling this hook to the toast runtime — the host wires it to useToast().
export function useVoiceRecorder(
  sid: string,
  onFeedback?: (outcome: VoiceOutcome) => void
): {
  state: VoiceState;
  toggle: () => void;
} {
  const [state, dispatch] = useReducer(voiceReducer, { kind: 'idle' });
  const mediaRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  // Keep the latest callback in a ref so the memoized stop()/start() don't
  // need to re-create when the host passes a fresh closure each render.
  const feedbackRef = useRef(onFeedback);
  feedbackRef.current = onFeedback;

  const cleanup = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    chunksRef.current = [];
  }, []);

  const stop = useCallback(async () => {
    const ctx = ctxRef.current;
    const inputRate = ctx?.sampleRate ?? 48000;
    // concatenate captured mono chunks
    const total = chunksRef.current.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunksRef.current) {
      merged.set(c, off);
      off += c.length;
    }
    cleanup();
    dispatch({ type: 'STOP' });

    const pcm = resampleTo16k(merged, inputRate);
    if (pcm.length < MIN_SAMPLES_16K) {
      dispatch({ type: 'DONE' }); // silent / too short — back to idle…
      feedbackRef.current?.({ kind: 'no-speech' }); // …but tell the user why
      return;
    }
    try {
      const res = await window.ccsmVoice?.transcribe(pcm);
      if (!res || !res.ok) {
        if (res && res.error === 'empty') {
          dispatch({ type: 'DONE' });
          feedbackRef.current?.({ kind: 'no-speech' });
          return;
        }
        const message = res ? res.error : 'transcribe-failed';
        dispatch({ type: 'FAIL', message });
        feedbackRef.current?.({ kind: 'error', message });
        return;
      }
      await pasteIntoActivePty(() => getTopShell()?.term, sid, res.text);
      dispatch({ type: 'DONE' });
    } catch {
      dispatch({ type: 'FAIL', message: 'transcribe-failed' });
      feedbackRef.current?.({ kind: 'error', message: 'transcribe-failed' });
    }
  }, [cleanup, sid]);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      chunksRef.current = [];
      processor.onaudioprocess = (e) => {
        // copy: the underlying buffer is reused by the audio thread
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      dispatch({ type: 'START' });
    } catch {
      cleanup();
      dispatch({ type: 'FAIL', message: 'mic' });
      feedbackRef.current?.({ kind: 'error', message: 'mic' });
    }
  }, [cleanup]);

  const toggle = useCallback(() => {
    if (state.kind === 'idle') void start();
    else if (state.kind === 'recording') void stop();
    else if (state.kind === 'error') dispatch({ type: 'RESET' });
    // transcribing: ignore (button disabled anyway)
  }, [state.kind, start, stop]);

  return { state, toggle };
}
