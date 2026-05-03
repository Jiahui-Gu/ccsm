// Tests for createFlashSink — the in-process executor in the notify pipeline.
//
// The sink owns:
//   1. A debounced timer per sid (re-flash resets duration).
//   2. An in-memory `flashStates` map mirrored onto globalThis.__ccsmFlashStates
//      for e2e probes + in-process consumers.
//
// Wave 0c (#217): the renderer-IPC half (`notify:flash`) is removed. The sink
// no longer pushes any IPC traffic; tests assert only the in-memory map and
// the auto-clear timer. Wave 0d will add a daemon-RPC push back in.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFlashSink, FLASH_DURATION_MS } from '../flashSink';
import type { Decision } from '../../notifyDecider';

function makeStubWin(opts: { destroyed?: boolean; webDestroyed?: boolean } = {}) {
  const sends: Array<{ channel: string; payload: unknown }> = [];
  const win = {
    isDestroyed: () => Boolean(opts.destroyed),
    webContents: {
      isDestroyed: () => Boolean(opts.webDestroyed),
      send: (channel: string, payload: unknown) => {
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

  it('records flash state and mirrors to globalThis (no IPC fan-out post-Wave-0c)', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    expect(sends).toEqual([]);
    expect(sink._peek()).toEqual({ s1: true });
    const g = globalThis as unknown as { __ccsmFlashStates: Record<string, boolean> };
    expect(g.__ccsmFlashStates).toBeDefined();
    expect(g.__ccsmFlashStates.s1).toBe(true);
  });

  it('auto-clears flash after durationMs', () => {
    const { win } = makeStubWin();
    const sink = createFlashSink({
      getMainWindow: () => win as never,
      durationMs: 100,
    });
    sink.apply(dec('s1', true));
    expect(sink._peek()).toEqual({ s1: true });
    vi.advanceTimersByTime(99);
    expect(sink._peek()).toEqual({ s1: true });
    vi.advanceTimersByTime(2);
    expect(sink._peek()).toEqual({});
  });

  it('re-flash before clear resets the timer (debounce)', () => {
    const { win } = makeStubWin();
    const sink = createFlashSink({
      getMainWindow: () => win as never,
      durationMs: 100,
    });
    sink.apply(dec('s1', true));
    vi.advanceTimersByTime(80);
    sink.apply(dec('s1', true)); // re-flash extends timer
    vi.advanceTimersByTime(80); // total 160 from first apply but only 80 since reset
    expect(sink._peek()).toEqual({ s1: true });
    vi.advanceTimersByTime(30); // crosses reset deadline
    expect(sink._peek()).toEqual({});
  });

  it('forget() clears state immediately', () => {
    const { win } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    sink.forget('s1');
    expect(sink._peek()).toEqual({});
  });

  it('forget() on an unknown sid is a no-op', () => {
    const { win, sends } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.forget('never-flashed');
    expect(sends).toEqual([]);
  });

  it('still records state when window is destroyed (no IPC layer to skip)', () => {
    const { win } = makeStubWin({ destroyed: true });
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    expect(sink._peek()).toEqual({ s1: true });
  });

  it('still records state when getMainWindow returns null', () => {
    const sink = createFlashSink({ getMainWindow: () => null });
    expect(() => sink.apply(dec('s1', true))).not.toThrow();
    expect(sink._peek()).toEqual({ s1: true });
  });

  it('uses default FLASH_DURATION_MS when durationMs not provided', () => {
    expect(FLASH_DURATION_MS).toBe(4_000);
    const { win } = makeStubWin();
    const sink = createFlashSink({ getMainWindow: () => win as never });
    sink.apply(dec('s1', true));
    vi.advanceTimersByTime(FLASH_DURATION_MS - 1);
    expect(sink._peek()).toEqual({ s1: true });
    vi.advanceTimersByTime(2);
    expect(sink._peek()).toEqual({});
  });

  it('handles independent sids without cross-talk', () => {
    const { win } = makeStubWin();
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
  });

  // Audit #876 cluster 1.14 / Task #884 — dispose() must clear ALL pending
  // timers and the flash map. (Wave 0c: assertions on IPC send count are gone
  // because the sink no longer pushes IPC.)
  describe('dispose()', () => {
    it('clears all pending timers + flash state', () => {
      const { win } = makeStubWin();
      const sink = createFlashSink({
        getMainWindow: () => win as never,
        durationMs: 1000,
      });
      sink.apply(dec('s1', true));
      sink.apply(dec('s2', true));
      sink.apply(dec('s3', true));
      expect(sink._peek()).toEqual({ s1: true, s2: true, s3: true });

      sink.dispose();

      expect(sink._peek()).toEqual({});

      // Timer leak check — advancing past the original duration must NOT
      // resurrect any state (timers were cleared).
      vi.advanceTimersByTime(2000);
      expect(sink._peek()).toEqual({});
    });

    it('is idempotent — second dispose is a no-op', () => {
      const { win } = makeStubWin();
      const sink = createFlashSink({ getMainWindow: () => win as never });
      sink.apply(dec('s1', true));
      sink.dispose();
      expect(() => sink.dispose()).not.toThrow();
    });

    it('dispose with no active flashes is safe', () => {
      const { win, sends } = makeStubWin();
      const sink = createFlashSink({ getMainWindow: () => win as never });
      expect(() => sink.dispose()).not.toThrow();
      expect(sends).toEqual([]);
    });
  });
});
