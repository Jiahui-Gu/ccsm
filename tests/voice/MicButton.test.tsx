import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import type { VoiceState } from '../../src/voice/recorderMachine';
import type { VoiceOutcome } from '../../src/voice/voiceFeedback';
import { ToastProvider } from '../../src/components/ui/Toast';
import { initI18n } from '../../src/i18n';

// We mock the recorder hook so the test drives MicButton's *presentation*
// (timer / labels / aria) from an arbitrary VoiceState, and can invoke the
// onFeedback callback to assert the toast wiring — without Web Audio. The
// capture/transcribe flow is covered separately (recorderMachine +
// voiceFeedback unit tests).
let mockState: VoiceState = { kind: 'idle' };
let lastFeedback: ((o: VoiceOutcome) => void) | undefined;
const toggle = vi.fn();

vi.mock('../../src/components/voice/useVoiceRecorder', () => ({
  useVoiceRecorder: (_sid: string, onFeedback?: (o: VoiceOutcome) => void) => {
    lastFeedback = onFeedback;
    return { state: mockState, toggle };
  },
}));

import { MicButton } from '../../src/components/voice/MicButton';

function renderButton() {
  return render(
    <ToastProvider>
      <MicButton sessionId="s1" />
    </ToastProvider>
  );
}

beforeEach(() => {
  initI18n('en');
  mockState = { kind: 'idle' };
  lastFeedback = undefined;
  toggle.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe('<MicButton /> feedback + a11y', () => {
  it('idle: descriptive start aria-label, not busy', () => {
    mockState = { kind: 'idle' };
    renderButton();
    const btn = screen.getByRole('button', { name: 'Start dictation' });
    expect(btn).toHaveAttribute('aria-busy', 'false');
  });

  it('recording: shows a live timer that ticks each second + reduced-motion-safe pulse', () => {
    mockState = { kind: 'recording' };
    renderButton();
    // Initial render shows 0:00.
    expect(screen.getByText(/Recording 0:00/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText(/Recording 0:03/)).toBeInTheDocument();
    // aria-label carries the elapsed time for screen readers.
    expect(
      screen.getByRole('button', { name: /Stop dictation, 0:03 elapsed/ })
    ).toBeInTheDocument();
    // Pulsing red dot is gated for prefers-reduced-motion.
    const dot = document.querySelector('.animate-pulse.motion-reduce\\:animate-none');
    expect(dot).not.toBeNull();
  });

  it('transcribing: visible label, aria-busy, disabled, motion-reduce spinner', () => {
    mockState = { kind: 'transcribing' };
    renderButton();
    expect(screen.getByText('Transcribing…')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Transcribing your speech, please wait' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
    const spinner = document.querySelector('.animate-spin.motion-reduce\\:animate-none');
    expect(spinner).not.toBeNull();
  });

  it('no-speech outcome pushes a polite info toast with reason + recovery', () => {
    mockState = { kind: 'idle' };
    renderButton();
    act(() => {
      lastFeedback?.({ kind: 'no-speech' });
    });
    const region = document.querySelector('[role="status"][aria-live="polite"]');
    expect(region?.textContent).toContain("Didn't catch that");
    expect(region?.textContent).toContain('Please try speaking again');
  });

  it('mic error outcome pushes an assertive error toast with recovery guidance', () => {
    mockState = { kind: 'error', message: 'mic' };
    renderButton();
    act(() => {
      lastFeedback?.({ kind: 'error', message: 'mic' });
    });
    const region = document.querySelector('[role="alert"][aria-live="assertive"]');
    expect(region?.textContent).toContain('Microphone access denied');
    expect(region?.textContent).toContain('system settings');
  });

  it('no-model error outcome explains the missing model', () => {
    mockState = { kind: 'error', message: 'no-model' };
    renderButton();
    act(() => {
      lastFeedback?.({ kind: 'error', message: 'no-model' });
    });
    const region = document.querySelector('[role="alert"][aria-live="assertive"]');
    expect(region?.textContent).toContain('Voice model not installed');
  });
});
