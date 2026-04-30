// Pure pub/sub for the pty:data fan-out registry.
//
// Pins the Set-deduped subscribe contract, the unsubscribe behaviour, and
// the "throwing subscriber must not wedge other subscribers" invariant the
// notify pipeline relies on (see electron/notify/sinks/pipeline.ts comment
// in dataFanout.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitPtyData, onPtyData, type PtyDataListener } from '../dataFanout';

// The registry is module-level. Each test must clean up its own
// subscribers — we collect dispose handles and run them in afterEach.
let disposers: Array<() => void> = [];

function track(cb: PtyDataListener): () => void {
  const dispose = onPtyData(cb);
  disposers.push(dispose);
  return dispose;
}

beforeEach(() => {
  disposers = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const d of disposers) {
    try { d(); } catch { /* noop */ }
  }
  disposers = [];
  vi.restoreAllMocks();
});

describe('onPtyData / emitPtyData', () => {
  it('delivers chunk + sid to a single subscriber', () => {
    const cb = vi.fn();
    track(cb);
    emitPtyData('sid-A', 'hello');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('sid-A', 'hello');
  });

  it('fans out the same chunk to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    track(a);
    track(b);
    track(c);
    emitPtyData('sid-X', 'chunk');
    expect(a).toHaveBeenCalledWith('sid-X', 'chunk');
    expect(b).toHaveBeenCalledWith('sid-X', 'chunk');
    expect(c).toHaveBeenCalledWith('sid-X', 'chunk');
  });

  it('dedupes the same callback reference (Set semantics)', () => {
    const cb = vi.fn();
    const d1 = onPtyData(cb);
    const d2 = onPtyData(cb);
    disposers.push(d1, d2);
    emitPtyData('sid', 'x');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further deliveries to that listener only', () => {
    const a = vi.fn();
    const b = vi.fn();
    const disposeA = track(a);
    track(b);
    emitPtyData('s', '1');
    disposeA();
    emitPtyData('s', '2');
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith('s', '1');
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe is idempotent (calling twice does not throw)', () => {
    const cb = vi.fn();
    const dispose = onPtyData(cb);
    dispose();
    expect(() => dispose()).not.toThrow();
    emitPtyData('s', 'x');
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing subscriber does not wedge the loop — sibling still fires', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    track(bad);
    track(good);
    expect(() => emitPtyData('sid', 'data')).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[ptyHost] data listener threw',
      expect.any(Error),
    );
  });

  it('emit with no subscribers is a no-op', () => {
    expect(() => emitPtyData('sid', 'no listeners')).not.toThrow();
  });

  it('zero-length chunks are still fanned out (transparency)', () => {
    const cb = vi.fn();
    track(cb);
    emitPtyData('sid', '');
    expect(cb).toHaveBeenCalledWith('sid', '');
  });
});
