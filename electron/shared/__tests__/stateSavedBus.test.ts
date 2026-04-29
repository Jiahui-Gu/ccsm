import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  emitStateSaved,
  onStateSaved,
  _resetStateSavedBusForTests,
} from '../stateSavedBus';

beforeEach(() => {
  _resetStateSavedBusForTests();
});

describe('stateSavedBus', () => {
  it('delivers emitted keys to a subscribed listener', () => {
    const seen: string[] = [];
    onStateSaved((k) => seen.push(k));
    emitStateSaved('foo');
    emitStateSaved('bar');
    expect(seen).toEqual(['foo', 'bar']);
  });

  it('fans out a single emit to all subscribers', () => {
    const a = vi.fn();
    const b = vi.fn();
    onStateSaved(a);
    onStateSaved(b);
    emitStateSaved('k');
    expect(a).toHaveBeenCalledWith('k');
    expect(b).toHaveBeenCalledWith('k');
  });

  it('returned unsubscribe function stops further deliveries', () => {
    const fn = vi.fn();
    const off = onStateSaved(fn);
    emitStateSaved('first');
    off();
    emitStateSaved('second');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('first');
  });

  it('isolates listener errors so a throwing listener does not break others', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const downstream = vi.fn();
    onStateSaved(() => {
      throw new Error('boom');
    });
    onStateSaved(downstream);
    // Producer must not see the error; downstream must still be called.
    expect(() => emitStateSaved('k')).not.toThrow();
    expect(downstream).toHaveBeenCalledWith('k');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('emit with no listeners is a no-op', () => {
    expect(() => emitStateSaved('orphan')).not.toThrow();
  });
});
