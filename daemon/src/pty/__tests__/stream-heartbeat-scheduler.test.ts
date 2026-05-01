import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHeartbeatScheduler,
  DEFAULT_HEARTBEAT_MS,
  MAX_HEARTBEAT_MS,
  MIN_HEARTBEAT_MS,
  type HeartbeatScheduler,
} from '../stream-heartbeat-scheduler.js';

// Hermetic timing — vi.useFakeTimers() patches global setInterval /
// clearInterval, which the scheduler picks up via its default timer
// hooks. No injection needed for the common path; the
// "custom-timers" suite exercises the injection seam separately.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stream-heartbeat-scheduler: construction', () => {
  it('rejects missing sendHeartbeat', () => {
    expect(() =>
      // @ts-expect-error — exercise runtime guard
      createHeartbeatScheduler({ intervalMs: 30_000 }),
    ).toThrow(TypeError);
  });
  it('rejects non-finite / non-integer intervals', () => {
    expect(() =>
      createHeartbeatScheduler({ intervalMs: Number.NaN, sendHeartbeat: () => {} }),
    ).toThrow(RangeError);
    expect(() =>
      createHeartbeatScheduler({ intervalMs: Infinity, sendHeartbeat: () => {} }),
    ).toThrow(RangeError);
    expect(() =>
      createHeartbeatScheduler({ intervalMs: 30_000.5, sendHeartbeat: () => {} }),
    ).toThrow(RangeError);
  });
  it('clamps below-min interval to MIN_HEARTBEAT_MS', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({ intervalMs: 100, sendHeartbeat: send });
    sch.start('a');
    vi.advanceTimersByTime(MIN_HEARTBEAT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith('a');
    sch.stop('a');
  });
  it('clamps above-max interval to MAX_HEARTBEAT_MS', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({
      intervalMs: 10 * 60 * 1000, // 10 min — over cap
      sendHeartbeat: send,
    });
    sch.start('a');
    vi.advanceTimersByTime(MAX_HEARTBEAT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith('a');
    sch.stop('a');
  });
  it('defaults to 30 s when intervalMs omitted', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({ sendHeartbeat: send });
    sch.start('a');
    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    sch.stop('a');
  });
});

describe('stream-heartbeat-scheduler: start / stop lifecycle', () => {
  let send: ReturnType<typeof vi.fn>;
  let sch: HeartbeatScheduler;

  beforeEach(() => {
    send = vi.fn();
    sch = createHeartbeatScheduler({ intervalMs: 10_000, sendHeartbeat: send });
  });

  it('emits at intervalMs cadence', () => {
    sch.start('s1');
    expect(sch.running()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith('s1');
  });

  it('first tick is one full interval after start, not immediate', () => {
    sch.start('s1');
    vi.advanceTimersByTime(9_999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stop cancels future ticks', () => {
    sch.start('s1');
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    sch.stop('s1');
    expect(sch.running()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('double-start is idempotent (no phase reset, no double schedule)', () => {
    sch.start('s1');
    vi.advanceTimersByTime(5_000);
    sch.start('s1'); // must NOT reset phase, must NOT add a second timer
    expect(sch.running()).toBe(1);
    vi.advanceTimersByTime(5_000);
    // If start had reset phase, send count would still be 0 here.
    // If start had double-scheduled, send count would be 2.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stop on unknown subId is a silent no-op', () => {
    expect(() => sch.stop('never-started')).not.toThrow();
    expect(sch.running()).toBe(0);
  });

  it('isolates multiple subIds', () => {
    sch.start('a');
    sch.start('b');
    sch.start('c');
    expect(sch.running()).toBe(3);
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(3);
    const calls = send.mock.calls.map((c) => c[0] as string).sort();
    expect(calls).toEqual(['a', 'b', 'c']);

    sch.stop('b');
    send.mockClear();
    vi.advanceTimersByTime(10_000);
    const second = send.mock.calls.map((c) => c[0] as string).sort();
    expect(second).toEqual(['a', 'c']);
  });

  it('swallows sendHeartbeat throws so one bad subId cannot starve others', () => {
    const calls: string[] = [];
    const sch2 = createHeartbeatScheduler({
      intervalMs: 10_000,
      sendHeartbeat: (id) => {
        calls.push(id);
        if (id === 'bad') throw new Error('boom');
      },
    });
    sch2.start('bad');
    sch2.start('good');
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(calls.sort()).toEqual(['bad', 'good']);
    // Next tick still happens for both — bad subId did not get
    // unscheduled by the throw.
    calls.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(calls.sort()).toEqual(['bad', 'good']);
    sch2.stop('bad');
    sch2.stop('good');
  });

  it('ticks counter is monotonic across all subIds', () => {
    sch.start('a');
    sch.start('b');
    vi.advanceTimersByTime(10_000);
    expect(sch.ticks()).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(sch.ticks()).toBe(4);
    sch.stop('a');
    sch.stop('b');
  });
});

describe('stream-heartbeat-scheduler: updateInterval', () => {
  it('applies on next tick — shortened interval', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({ intervalMs: 30_000, sendHeartbeat: send });
    sch.start('a');
    vi.advanceTimersByTime(30_000);
    expect(send).toHaveBeenCalledTimes(1);
    sch.updateInterval(5_000);
    // Next tick should land 5_000 after the updateInterval call,
    // not 30_000 — old timer torn down.
    vi.advanceTimersByTime(4_999);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(3);
    sch.stop('a');
  });

  it('applies on next tick — lengthened interval', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({ intervalMs: 5_000, sendHeartbeat: send });
    sch.start('a');
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    sch.updateInterval(60_000);
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(1); // old 5 s would have fired here
    vi.advanceTimersByTime(55_000);
    expect(send).toHaveBeenCalledTimes(2);
    sch.stop('a');
  });

  it('applies to all running subIds at once', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({ intervalMs: 30_000, sendHeartbeat: send });
    sch.start('a');
    sch.start('b');
    sch.updateInterval(5_000);
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    const ids = send.mock.calls.map((c) => c[0] as string).sort();
    expect(ids).toEqual(['a', 'b']);
    sch.stop('a');
    sch.stop('b');
  });

  it('no-op when newMs equals current interval (no timer churn)', () => {
    const cleared: unknown[] = [];
    const set: unknown[] = [];
    const sch = createHeartbeatScheduler({
      intervalMs: 10_000,
      sendHeartbeat: () => {},
      timers: {
        setInterval: (cb, ms) => {
          const h = setInterval(cb, ms);
          set.push(h);
          return h;
        },
        clearInterval: (h) => {
          cleared.push(h);
          clearInterval(h as ReturnType<typeof setInterval>);
        },
      },
    });
    sch.start('a');
    expect(set).toHaveLength(1);
    sch.updateInterval(10_000); // same value — must not churn
    expect(set).toHaveLength(1);
    expect(cleared).toHaveLength(0);
    sch.stop('a');
  });

  it('clamps newMs below MIN_HEARTBEAT_MS', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({ intervalMs: 30_000, sendHeartbeat: send });
    sch.start('a');
    sch.updateInterval(100); // → clamped to 5_000
    vi.advanceTimersByTime(MIN_HEARTBEAT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    sch.stop('a');
  });

  it('clamps newMs above MAX_HEARTBEAT_MS', () => {
    const send = vi.fn();
    const sch = createHeartbeatScheduler({ intervalMs: 30_000, sendHeartbeat: send });
    sch.start('a');
    sch.updateInterval(60 * 60 * 1000); // 1 h → clamped to 5 min
    vi.advanceTimersByTime(MAX_HEARTBEAT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    sch.stop('a');
  });

  it('rejects non-integer / non-finite newMs', () => {
    const sch = createHeartbeatScheduler({
      intervalMs: 30_000,
      sendHeartbeat: () => {},
    });
    expect(() => sch.updateInterval(Number.NaN)).toThrow(RangeError);
    expect(() => sch.updateInterval(Infinity)).toThrow(RangeError);
    expect(() => sch.updateInterval(10_000.5)).toThrow(RangeError);
  });

  it('does NOT notify or restart anything beyond its own timers (decoupled from T44)', () => {
    // Contract test: updateInterval mutates ONLY the scheduler's own
    // setInterval handles. There is no callback hook for "interval
    // changed" — the wiring layer recomputes the detector deadline on
    // its own schedule per spec §6.5.1.
    const sch = createHeartbeatScheduler({
      intervalMs: 30_000,
      sendHeartbeat: () => {},
    });
    // The returned shape exposes exactly the 5 documented members.
    // Adding a side-effect hook would surface here as a public API
    // breakage — that's the test's whole point.
    expect(Object.keys(sch).sort()).toEqual(
      ['running', 'start', 'stop', 'ticks', 'updateInterval'].sort(),
    );
  });
});

describe('stream-heartbeat-scheduler: custom timer hook injection', () => {
  it('routes setInterval / clearInterval through injected hooks', () => {
    let scheduledMs: number | undefined;
    let scheduledCb: (() => void) | undefined;
    let cleared = false;
    const fakeHandle = Symbol('fake-timer');
    const sch = createHeartbeatScheduler({
      intervalMs: 30_000,
      sendHeartbeat: vi.fn(),
      timers: {
        setInterval: (cb, ms) => {
          scheduledCb = cb;
          scheduledMs = ms;
          return fakeHandle;
        },
        clearInterval: (h) => {
          expect(h).toBe(fakeHandle);
          cleared = true;
        },
      },
    });
    sch.start('a');
    expect(scheduledMs).toBe(30_000);
    expect(typeof scheduledCb).toBe('function');
    sch.stop('a');
    expect(cleared).toBe(true);
  });
});
