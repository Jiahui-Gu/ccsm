// Tests for createFlashSink — the renderer-IPC sink in the notify pipeline.
//
// The sink owns:
//   1. A debounced timer per sid (re-flash resets duration).
//   2. An in-memory `flashStates` map mirrored onto globalThis.__ccsmFlashStates
//      for e2e probes.
//   3. Outgoing `notify:flash` IPC sends to the main BrowserWindow.
//
// We assert real behavior end-to-end through a stub BrowserWindow that
// records sends, plus fake timers to drive the debounce + auto-clear.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFlashSink, FLASH_DURATION_MS } from '../flashSink';
import type { Decision } from '../../notifyDecider';

interface SendCall {
  channel: string;
  payload: { sid: string; on: boolean };
}

function makeStubWin(opts: { destroyed?: boolean; webDestroyed?: boolean } = {}) {
  const sends: SendCall[] = [];
  const win = {
    isDestroyed: () => Boolean(opts.destroyed),
    webContents: {
      isDestroyed: () => Boolean(opts.webDestroyed),
      send: (channel: string, payload: { sid: string; on: boolean }) => {
        sends.push({ channel, payload });
      },
    },
  };
  return { win, sends };
}

function dec(sid: string, flash: boolean, toast = false): Decision {
  return { sid, flash, toast };
}

describe('createFlashSink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete (globalThis as { __ccsmFlashStates?: unknown }).__ccsmFlashStates;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when decision.flash is false', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', false));
    expect(sends).toEqual([]);
    expect(sink._peek()).toEqual({});
  });

  it('sends notify:flash with on=true and mirrors state to globalThis', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    expect(sends).toEqual([{ channel: 'notify:flash', payload: { sid: 's1', on: true } }]);
    expect(sink._peek()).toEqual({ s1: true });
    const g = globalThis as unknown as { __ccsmFlashStates: Record<string, boolean> };
    expect(g.__ccsmFlashStates).toBeDefined();
    expect(g.__ccsmFlashStates.s1).toBe(true);
  });

  it('auto-clears flash after durationMs and sends on=false', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({
      getMainWindow: () => win as never,
      durationMs: 100,
    });
    sink.apply(dec('s1', true));
    expect(sends.length).toBe(1);
    vi.advanceTimersByTime(99);
    expect(sends.length).toBe(1);
    vi.advanceTimersByTime(2);
    expect(sends.length).toBe(2);
    expect(sends[1]).toEqual({ channel: 'notify:flash', payload: { sid: 's1', on: false } });
    expect(sink._peek()).toEqual({});
  });

  it('re-flash before clear resets the timer (debounce) without an extra on=true send', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({
      getMainWindow: () => win as never,
      durationMs: 100,
    });
    sink.apply(dec('s1', true));
    vi.advanceTimersByTime(80);
    sink.apply(dec('s1', true)); // re-flash extends timer
    vi.advanceTimersByTime(80); // total 160 from first apply but only 80 since reset
    // Still no clear yet — only original on=true was sent.
    expect(sends.length).toBe(1);
    vi.advanceTimersByTime(30); // crosses reset deadline
    expect(sends.length).toBe(2);
    expect(sends[1]!.payload).toEqual({ sid: 's1', on: false });
  });

  it('forget() clears state immediately and sends on=false', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    sink.forget('s1');
    expect(sends.length).toBe(2);
    expect(sends[1]!.payload).toEqual({ sid: 's1', on: false });
    expect(sink._peek()).toEqual({});
  });

  it('forget() on an unknown sid is a no-op', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.forget('never-flashed');
    expect(sends).toEqual([]);
  });

  it('skips send when window is destroyed', () => {
    const { win, sends } = makeStubWin({ destroyed: true });
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    expect(sends).toEqual([]);
    // Local state still updated (so probes can still observe).
    expect(sink._peek()).toEqual({ s1: true });
  });

  it('skips send when webContents is destroyed', () => {
    const { win, sends } = makeStubWin({ webDestroyed: true });
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    expect(sends).toEqual([]);
  });

  it('skips send when getMainWindow returns null', () => {
    const sink = createFlashSink({ getMainWindow: () => null });
    // Just must not throw.
    expect(() => sink.apply(dec('s1', true))).not.toThrow();
  });

  it('uses default FLASH_DURATION_MS when durationMs not provided', () => {
    expect(FLASH_DURATION_MS).toBe(4_000);
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    vi.advanceTimersByTime(FLASH_DURATION_MS - 1);
    expect(sends.length).toBe(1);
    vi.advanceTimersByTime(2);
    expect(sends.length).toBe(2);
  });

  it('handles independent sids without cross-talk', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({
      getMainWindow: () => win as never,
      durationMs: 50,
    });
    sink.apply(dec('s1', true));
    sink.apply(dec('s2', true));
    expect(sink._peek()).toEqual({ s1: true, s2: true });
    sink.forget('s1');
    expect(sink._peek()).toEqual({ s2: true });
    vi.advanceTimersByTime(60);
    expect(sink._peek()).toEqual({});
    // 2 on=true + 1 forget(s1)on=false + 1 auto(s2)on=false = 4 sends.
    expect(sends.length).toBe(4);
  });

  // Audit #876 cluster 1.14 / Task #884 — dispose() must clear ALL pending
  // timers and the flash map. Reverse-verify: comment out the `clear(sid)`
  // loop in dispose() and the timer-leak assertion below fails (the auto-
  // fire would still happen + sends.length grows past expectation).
  describe('dispose()', () => {
    it('clears all pending timers + flash state and sends on=false for each active sid', () => {
      const { win, sends } = makeStubWin();
      const sink = createFlashSink({
        getMainWindow: () => win as never,
        durationMs: 1000,
      });
      sink.apply(dec('s1', true));
      sink.apply(dec('s2', true));
      sink.apply(dec('s3', true));
      expect(sink._peek()).toEqual({ s1: true, s2: true, s3: true });
      expect(sends.length).toBe(3); // 3 on=true

      sink.dispose();

      // All three flash entries cleared + on=false sent for each.
      expect(sink._peek()).toEqual({});
      expect(sends.length).toBe(6); // + 3 on=false
      const offSids = sends.slice(3).map((s) => s.payload.sid).sort();
      expect(offSids).toEqual(['s1', 's2', 's3']);

      // Timer leak check — advancing past the original duration must NOT
      // fire any additional sends (timers were cleared).
      vi.advanceTimersByTime(2000);
      expect(sends.length).toBe(6);
    });

    it('is idempotent — second dispose is a no-op', () => {
      const { win, sends } = makeStubWin();
      const sink = createFlashSink({ getMainWindow: () => win as never });
      sink.apply(dec('s1', true));
      sink.dispose();
      const sendsBefore = sends.length;
      sink.dispose();
      expect(sends.length).toBe(sendsBefore);
    });

    it('dispose with no active flashes is safe', () => {
      const { win, sends } = makeStubWin();
      const sink = createFlashSink({ getMainWindow: () => win as never });
      expect(() => sink.dispose()).not.toThrow();
      expect(sends).toEqual([]);
    });
  });
});
