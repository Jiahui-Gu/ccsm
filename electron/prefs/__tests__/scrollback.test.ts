import { describe, it, expect, beforeEach, vi } from 'vitest';

const stateStore = new Map<string, string | null>();
let throwOnLoad = false;

vi.mock('../../db', () => ({
  loadState: (key: string) => {
    if (throwOnLoad) throw new Error('boom');
    return stateStore.has(key) ? stateStore.get(key)! : null;
  },
  saveState: (key: string, value: string) => {
    stateStore.set(key, value);
  },
}));

beforeEach(() => {
  stateStore.clear();
  throwOnLoad = false;
  vi.resetModules();
});

describe('parseScrollbackLines', () => {
  it('returns the default when raw is null/undefined/empty', async () => {
    const { parseScrollbackLines, DEFAULT_SCROLLBACK_LINES } = await import(
      '../scrollback'
    );
    expect(parseScrollbackLines(null)).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(parseScrollbackLines(undefined)).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(parseScrollbackLines('')).toBe(DEFAULT_SCROLLBACK_LINES);
  });

  it('accepts numeric strings (TEXT-column round-trip)', async () => {
    const { parseScrollbackLines } = await import('../scrollback');
    expect(parseScrollbackLines('2500')).toBe(2500);
  });

  it('clamps below MIN', async () => {
    const { parseScrollbackLines, MIN_SCROLLBACK_LINES } = await import(
      '../scrollback'
    );
    expect(parseScrollbackLines(0)).toBe(MIN_SCROLLBACK_LINES);
    expect(parseScrollbackLines(-9999)).toBe(MIN_SCROLLBACK_LINES);
  });

  it('clamps above MAX', async () => {
    const { parseScrollbackLines, MAX_SCROLLBACK_LINES } = await import(
      '../scrollback'
    );
    expect(parseScrollbackLines(999_999)).toBe(MAX_SCROLLBACK_LINES);
  });

  it('rounds non-integers', async () => {
    const { parseScrollbackLines } = await import('../scrollback');
    expect(parseScrollbackLines(1500.4)).toBe(1500);
    expect(parseScrollbackLines(1500.6)).toBe(1501);
  });

  it('falls back to default for NaN / non-numeric strings', async () => {
    const { parseScrollbackLines, DEFAULT_SCROLLBACK_LINES } = await import(
      '../scrollback'
    );
    expect(parseScrollbackLines('abc')).toBe(DEFAULT_SCROLLBACK_LINES);
    expect(parseScrollbackLines(NaN)).toBe(DEFAULT_SCROLLBACK_LINES);
  });
});

describe('loadScrollbackLines', () => {
  it('returns the default when the row is missing', async () => {
    const { loadScrollbackLines, DEFAULT_SCROLLBACK_LINES } = await import(
      '../scrollback'
    );
    expect(loadScrollbackLines()).toBe(DEFAULT_SCROLLBACK_LINES);
  });

  it('reads the persisted value (numeric string)', async () => {
    stateStore.set('scrollbackLines', '3000');
    const { loadScrollbackLines } = await import('../scrollback');
    expect(loadScrollbackLines()).toBe(3000);
  });

  it('clamps an out-of-range persisted value', async () => {
    stateStore.set('scrollbackLines', '999999');
    const { loadScrollbackLines, MAX_SCROLLBACK_LINES } = await import(
      '../scrollback'
    );
    expect(loadScrollbackLines()).toBe(MAX_SCROLLBACK_LINES);
  });

  it('returns the default when loadState throws', async () => {
    throwOnLoad = true;
    const { loadScrollbackLines, DEFAULT_SCROLLBACK_LINES } = await import(
      '../scrollback'
    );
    expect(loadScrollbackLines()).toBe(DEFAULT_SCROLLBACK_LINES);
  });

  it('caches after first read; cache invalidation re-reads', async () => {
    stateStore.set('scrollbackLines', '500');
    const { loadScrollbackLines, invalidateScrollbackCache } = await import(
      '../scrollback'
    );
    expect(loadScrollbackLines()).toBe(500);
    stateStore.set('scrollbackLines', '4000');
    // Cache still serves the old value.
    expect(loadScrollbackLines()).toBe(500);
    invalidateScrollbackCache();
    expect(loadScrollbackLines()).toBe(4000);
  });
});

describe('subscribeScrollbackInvalidation', () => {
  it('invalidates the cache when stateSavedBus emits SCROLLBACK_KEY', async () => {
    stateStore.set('scrollbackLines', '500');
    const { loadScrollbackLines, subscribeScrollbackInvalidation } =
      await import('../scrollback');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeScrollbackInvalidation();
    expect(loadScrollbackLines()).toBe(500);

    stateStore.set('scrollbackLines', '4000');
    emitStateSaved('scrollbackLines');
    expect(loadScrollbackLines()).toBe(4000);
    off();
  });

  it('ignores unrelated keys', async () => {
    stateStore.set('scrollbackLines', '500');
    const { loadScrollbackLines, subscribeScrollbackInvalidation } =
      await import('../scrollback');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeScrollbackInvalidation();
    expect(loadScrollbackLines()).toBe(500);

    stateStore.set('scrollbackLines', '4000');
    emitStateSaved('closeAction');
    // Unrelated key did not invalidate; cache still serves 500.
    expect(loadScrollbackLines()).toBe(500);
    off();
  });

  it('reverse-verify: unsubscribed listener no longer invalidates', async () => {
    stateStore.set('scrollbackLines', '500');
    const { loadScrollbackLines, subscribeScrollbackInvalidation } =
      await import('../scrollback');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeScrollbackInvalidation();
    loadScrollbackLines(); // prime cache
    off();

    stateStore.set('scrollbackLines', '4000');
    emitStateSaved('scrollbackLines');
    // Listener detached → cache still stale.
    expect(loadScrollbackLines()).toBe(500);
  });
});
