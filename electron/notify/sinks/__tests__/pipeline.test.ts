// Tests for installNotifyPipeline — the orchestrator that wires the OSC
// title sniffer (producer), runStateTracker (decider), and the toast +
// flash sinks. We exercise the full path with REAL sniffer + REAL tracker
// + a recording toast impl + a stub BrowserWindow, so the test asserts
// "PTY chunk in -> decision -> sink call" wiring rather than mock plumbing.

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

interface SendCall {
  channel: string;
  payload: unknown;
}

function makeStubWin() {
  const sends: SendCall[] = [];
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sends.push({ channel, payload }),
    },
  };
  return { win, sends };
}

// Wrap a title in the OSC 0 escape sequence the CLI emits.
function osc(title: string): string {
  return `\x1b]0;${title}\x07`;
}

const IDLE_TITLE = '✳ Claude Code'; // sparkle = idle, per titleStateClassifier
const RUNNING_TITLE = '⠂ Claude Code'; // braille = running

describe('installNotifyPipeline (Task #743 orchestrator)', () => {
  beforeEach(() => {
    process.env.CCSM_NOTIFY_TEST_HOOK = '1';
    delete (globalThis as { __ccsmNotifyLog?: unknown }).__ccsmNotifyLog;
    delete (globalThis as { __ccsmFlashStates?: unknown }).__ccsmFlashStates;
    delete (globalThis as { __ccsmDebug?: unknown }).__ccsmDebug;
  });
  afterEach(() => {
    delete process.env.CCSM_NOTIFY_TEST_HOOK;
  });

  it('running -> idle (unfocused) feeds a toast + flash via the sinks', () => {
    const { win, sends } = makeStubWin();
    const onNotified = vi.fn();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
      getNameFn: () => 'Test',
      onNotified,
    });
    pipeline.setFocused(false); // Rule 5

    pipeline.feedChunk('s1', osc(RUNNING_TITLE));
    pipeline.feedChunk('s1', osc(IDLE_TITLE));

    // Toast sink fired (test-hook impl writes to globalThis log).
    const log = (globalThis as { __ccsmNotifyLog?: Array<{ sid: string }> }).__ccsmNotifyLog;
    expect(log).toBeDefined();
    expect(log!.length).toBe(1);
    expect(log![0]!.sid).toBe('s1');
    expect(onNotified).toHaveBeenCalledWith('s1');

    // Flash sink fired notify:flash IPC.
    const flashSends = sends.filter((s) => s.channel === 'notify:flash');
    expect(flashSends.length).toBe(1);
    expect(flashSends[0]!.payload).toEqual({ sid: 's1', on: true });

    pipeline.dispose();
  });

  it('global mute short-circuits BEFORE the tracker runs (no decision, no fire)', () => {
    const { win, sends } = makeStubWin();
    const onNotified = vi.fn();
    let muted = false;
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => muted,
      onNotified,
    });
    pipeline.setFocused(false);

    pipeline.feedChunk('s1', osc(RUNNING_TITLE));
    muted = true;
    pipeline.feedChunk('s1', osc(IDLE_TITLE));

    expect(onNotified).not.toHaveBeenCalled();
    expect(sends.filter((s) => s.channel === 'notify:flash')).toEqual([]);
    pipeline.dispose();
  });

  it('markUserInput sticky-mutes the sid (no toast on subsequent run)', () => {
    const { win, sends } = makeStubWin();
    const onNotified = vi.fn();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
      onNotified,
    });
    pipeline.setFocused(false);
    pipeline.markUserInput('s1');

    pipeline.feedChunk('s1', osc(RUNNING_TITLE));
    pipeline.feedChunk('s1', osc(IDLE_TITLE));

    expect(onNotified).not.toHaveBeenCalled();
    // Mute (Rule 7) suppresses toast but still fires flash.
    expect(sends.some((s) => s.channel === 'notify:flash')).toBe(true);
    pipeline.dispose();
  });

  it('forgetSid clears sniffer + tracker + flash state', () => {
    const { win } = makeStubWin();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
    });
    pipeline.setFocused(false);
    pipeline.feedChunk('s1', osc(RUNNING_TITLE));
    pipeline.feedChunk('s1', osc(IDLE_TITLE)); // creates flash state
    expect(pipeline._internals().flash._peek()['s1']).toBe(true);
    pipeline.forgetSid('s1');
    expect(pipeline._internals().flash._peek()['s1']).toBeUndefined();
    pipeline.dispose();
  });

  it('setMuted suppresses toast for the sid (Rule 7) but a different sid still fires', () => {
    const { win } = makeStubWin();
    const onNotified = vi.fn();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
      onNotified,
    });
    pipeline.setFocused(false);
    pipeline.setMuted('s1', true);

    pipeline.feedChunk('s1', osc(RUNNING_TITLE));
    pipeline.feedChunk('s1', osc(IDLE_TITLE));
    expect(onNotified).not.toHaveBeenCalledWith('s1');

    // A non-muted sid still fires through the same pipeline.
    pipeline.feedChunk('s2', osc(RUNNING_TITLE));
    pipeline.feedChunk('s2', osc(IDLE_TITLE));
    expect(onNotified).toHaveBeenCalledWith('s2');
    pipeline.dispose();
  });

  it('projectCtx surfaces tracker focused/active state for inspectors', () => {
    const { win } = makeStubWin();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
    });
    pipeline.setFocused(true);
    pipeline.setActiveSid('s1');
    const ctx = pipeline._internals().ctx;
    expect(ctx.focused).toBe(true);
    expect(ctx.activeSid).toBe('s1');
    pipeline.dispose();
  });

  it('diag counters populate only when globalThis.__ccsmDebug is truthy', () => {
    const { win } = makeStubWin();
    (globalThis as { __ccsmDebug?: boolean }).__ccsmDebug = true;
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
    });
    pipeline.setFocused(false);
    pipeline.feedChunk('s1', osc(RUNNING_TITLE));
    pipeline.feedChunk('s1', osc(IDLE_TITLE));
    const diag = pipeline._internals().diag;
    expect(diag).not.toBeNull();
    expect(diag!.chunksFed).toBe(2);
    expect(diag!.bytesFed).toBeGreaterThan(0);
    expect(diag!.snifferEvents).toBe(2);
    expect(diag!.classifications.idle).toBe(1);
    expect(diag!.classifications.running).toBe(1);
    expect(diag!.decisions).toBe(1);
    pipeline.dispose();
  });

  it('dispose detaches sniffer listeners (subsequent feeds produce no decisions)', () => {
    const { win } = makeStubWin();
    const onNotified = vi.fn();
    const pipeline = installNotifyPipeline({
      getMainWindow: () => win as never,
      isGlobalMutedFn: () => false,
      onNotified,
    });
    pipeline.setFocused(false);
    pipeline.dispose();
    pipeline.feedChunk('s1', osc(RUNNING_TITLE));
    pipeline.feedChunk('s1', osc(IDLE_TITLE));
    expect(onNotified).not.toHaveBeenCalled();
  });

  // Audit #876 cluster 1.14 / Task #884 — pipeline.dispose() must clear
  // any active flash timers (delegated to flash.dispose()), otherwise
  // every still-flashing sid leaks its setTimeout closure past disposal.
  // Reverse-verify: drop the `flash.dispose()` call in pipeline.ts and
  // the `_peek()` empty assertion below fails.
  it('dispose clears flash sink state (no leaked timers)', () => {
    vi.useFakeTimers();
    try {
      const { win, sends } = makeStubWin();
      const pipeline = installNotifyPipeline({
        getMainWindow: () => win as never,
        isGlobalMutedFn: () => false,
      });
      pipeline.setFocused(false);
      pipeline.feedChunk('s1', osc(RUNNING_TITLE));
      pipeline.feedChunk('s1', osc(IDLE_TITLE));
      pipeline.feedChunk('s2', osc(RUNNING_TITLE));
      pipeline.feedChunk('s2', osc(IDLE_TITLE));
      const flash = pipeline._internals().flash;
      expect(Object.keys(flash._peek()).sort()).toEqual(['s1', 's2']);

      pipeline.dispose();

      // Flash map cleared; on=false IPC sent for both sids.
      expect(flash._peek()).toEqual({});
      const offSends = sends.filter(
        (s) =>
          s.channel === 'notify:flash' &&
          (s.payload as { on: boolean }).on === false,
      );
      expect(offSends.length).toBe(2);

      // Advance well past FLASH_DURATION_MS — no late timer fires.
      const sendsAfterDispose = sends.length;
      vi.advanceTimersByTime(10_000);
      expect(sends.length).toBe(sendsAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});
