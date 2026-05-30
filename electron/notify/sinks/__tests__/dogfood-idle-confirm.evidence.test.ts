// Dogfood evidence for the notify idle-confirmation window.
//
// This is the headless, deterministic proof for the original bug: CCSM used
// to fire a notification on a MID-TASK PAUSE (a transient `✳` title the CLI
// emits between tool steps, immediately followed by `running` when it resumes
// itself). The fix folds an IDLE_CONFIRM_MS window into runStateTracker so a
// `✳` that is followed by `running` within the window is dropped, and only a
// `✳` that stays idle past the window (a REAL stop — Claude asked a question
// or finished the task) fires exactly one notification.
//
// Unlike the byte-stream e2e harness, this drives the FULL real pipeline
// (`installNotifyPipeline` → real OscTitleSniffer → real runStateTracker →
// real toast sink test-seam) with raw OSC bytes — the same bytes node-pty
// would deliver — under vitest fake timers so the 1500ms window is exercised
// to the millisecond.
//
// WHAT THIS PROVES (headless):
//   1. A realistic running→idle→running→idle→…→running pause storm produces
//      ZERO notifications.
//   2. A running→idle→(silence > window) real stop produces EXACTLY ONE.
//   3. The single notification carries the correct sid.
//
// WHAT THIS CANNOT PROVE (needs a real device / real CLI):
//   - That the OS actually renders the toast and the flash is visible.
//   - That the real Claude CLI emits these exact OSC glyph transitions at
//     these timings (the e2e seam cannot drive real idle transitions without
//     a live Anthropic backend — documented in
//     scripts/harness-e2e-window-lifecycle-notify.mjs). This spec asserts the
//     pipeline's discrimination logic given the documented OSC contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  BrowserWindow: class {},
}));

import { installNotifyPipeline } from '../pipeline';
import { IDLE_CONFIRM_MS } from '../../runStateTracker';

// Real OSC 0 byte sequences, exactly as node-pty delivers them from the CLI.
function osc(title: string): string {
  return `\x1b]0;${title}\x07`;
}
const RUNNING = osc('⠂ Claude Code'); // braille spinner frame = running
const IDLE = osc('✳ Claude Code'); // sparkle = idle / waiting for input

interface NotifyEntry {
  sid: string;
}

function makeStubWin() {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: () => false,
      send: vi.fn(),
    },
  };
}

function notifyLog(): NotifyEntry[] {
  return (
    (globalThis as { __ccsmNotifyLog?: NotifyEntry[] }).__ccsmNotifyLog ?? []
  );
}

describe('DOGFOOD: notify idle-confirmation window (real pipeline, real bytes)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.CCSM_NOTIFY_TEST_HOOK = '1';
    delete (globalThis as { __ccsmNotifyLog?: unknown }).__ccsmNotifyLog;
  });
  afterEach(() => {
    delete process.env.CCSM_NOTIFY_TEST_HOOK;
    vi.useRealTimers();
  });

  it('EVIDENCE 1 — mid-task pause storm fires ZERO notifications', () => {
    const win = makeStubWin();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
      getNameFn: () => 'dogfood',
    });
    pipeline.setFocused(false); // unfocused — most aggressive toast path (Rule 5)

    // A realistic multi-step turn: each tool call ends with a brief `✳` pause
    // that is well under the confirmation window, then the CLI resumes itself
    // with `running`. This is the exact pattern that used to mis-fire.
    pipeline.feedChunk('s1', RUNNING);
    for (let step = 0; step < 6; step++) {
      vi.advanceTimersByTime(800); // tool runs ~800ms
      pipeline.feedChunk('s1', IDLE); // brief pause between steps
      vi.advanceTimersByTime(IDLE_CONFIRM_MS - 400); // pause < window
      pipeline.feedChunk('s1', RUNNING); // CLI resumes itself → cancels window
    }
    // Drain any timers far past the window — nothing should be pending.
    vi.advanceTimersByTime(IDLE_CONFIRM_MS * 3);

    expect(notifyLog()).toEqual([]);
    expect(pipeline._internals().tracker._internals().pendingIdleSids).toEqual(
      [],
    );
    pipeline.dispose();
  });

  it('EVIDENCE 2 — a real stop fires EXACTLY ONE notification with the right sid', () => {
    const win = makeStubWin();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
      getNameFn: () => 'dogfood',
    });
    pipeline.setFocused(false);

    // Same turn as EVIDENCE 1, but the final `✳` is a REAL stop: Claude asked
    // a question / finished. No `running` follows, so the window elapses.
    pipeline.feedChunk('s1', RUNNING);
    for (let step = 0; step < 3; step++) {
      vi.advanceTimersByTime(800);
      pipeline.feedChunk('s1', IDLE);
      vi.advanceTimersByTime(IDLE_CONFIRM_MS - 400);
      pipeline.feedChunk('s1', RUNNING);
    }
    vi.advanceTimersByTime(500);
    pipeline.feedChunk('s1', IDLE); // the real stop
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 50); // silence past the window

    const log = notifyLog();
    expect(log.length).toBe(1);
    expect(log[0]!.sid).toBe('s1');
    pipeline.dispose();
  });

  it('EVIDENCE 3 — concurrent sessions: one pauses, one really stops', () => {
    const win = makeStubWin();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
      getNameFn: () => 'dogfood',
    });
    pipeline.setFocused(false);

    // s1 pauses mid-task; s2 really stops. Only s2 should notify.
    pipeline.feedChunk('s1', RUNNING);
    pipeline.feedChunk('s2', RUNNING);
    vi.advanceTimersByTime(500);

    pipeline.feedChunk('s1', IDLE); // s1 pause begins
    pipeline.feedChunk('s2', IDLE); // s2 stop begins
    vi.advanceTimersByTime(IDLE_CONFIRM_MS - 300);
    pipeline.feedChunk('s1', RUNNING); // s1 resumes → its window cancels

    // s2 never resumes — its window elapses.
    vi.advanceTimersByTime(IDLE_CONFIRM_MS + 50);

    const log = notifyLog();
    expect(log.length).toBe(1);
    expect(log[0]!.sid).toBe('s2');
    pipeline.dispose();
  });
});
