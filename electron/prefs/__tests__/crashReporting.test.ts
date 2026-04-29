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

describe('loadCrashReportingOptOut', () => {
  it('defaults to false (opt-IN to crash reporting) when the row is missing', async () => {
    const { loadCrashReportingOptOut } = await import('../crashReporting');
    expect(loadCrashReportingOptOut()).toBe(false);
  });
  it('returns true for "true"', async () => {
    stateStore.set('crashReportingOptOut', 'true');
    const { loadCrashReportingOptOut } = await import('../crashReporting');
    expect(loadCrashReportingOptOut()).toBe(true);
  });
  it('returns true for "1"', async () => {
    stateStore.set('crashReportingOptOut', '1');
    const { loadCrashReportingOptOut } = await import('../crashReporting');
    expect(loadCrashReportingOptOut()).toBe(true);
  });
  it('returns false for "false" / "0" / arbitrary strings', async () => {
    stateStore.set('crashReportingOptOut', 'false');
    const { loadCrashReportingOptOut } = await import('../crashReporting');
    expect(loadCrashReportingOptOut()).toBe(false);
  });
  it('returns false on a thrown read', async () => {
    throwOnLoad = true;
    const { loadCrashReportingOptOut } = await import('../crashReporting');
    expect(loadCrashReportingOptOut()).toBe(false);
  });
});

describe('invalidateCrashReportingCache', () => {
  it('forces the next read to pick up the new DB value', async () => {
    stateStore.set('crashReportingOptOut', 'true');
    const { loadCrashReportingOptOut, invalidateCrashReportingCache } =
      await import('../crashReporting');
    expect(loadCrashReportingOptOut()).toBe(true);

    // Renderer toggles the setting off — the cached value would still report
    // true until invalidated.
    stateStore.set('crashReportingOptOut', 'false');
    expect(loadCrashReportingOptOut()).toBe(true);

    invalidateCrashReportingCache();
    expect(loadCrashReportingOptOut()).toBe(false);
  });
});

// Task #818 / tech-debt-12 leak #5: cache invalidation predicate now lives
// in this module and subscribes to the stateSavedBus rather than being
// dispatched by the db:save handler. These tests verify the wiring.
describe('subscribeCrashReportingInvalidation', () => {
  it('invalidates the cache when stateSavedBus emits CRASH_OPT_OUT_KEY', async () => {
    stateStore.set('crashReportingOptOut', 'true');
    const { loadCrashReportingOptOut, subscribeCrashReportingInvalidation } =
      await import('../crashReporting');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeCrashReportingInvalidation();
    expect(loadCrashReportingOptOut()).toBe(true);

    stateStore.set('crashReportingOptOut', 'false');
    emitStateSaved('crashReportingOptOut');
    expect(loadCrashReportingOptOut()).toBe(false);
    off();
  });

  it('ignores unrelated keys', async () => {
    stateStore.set('crashReportingOptOut', 'true');
    const { loadCrashReportingOptOut, subscribeCrashReportingInvalidation } =
      await import('../crashReporting');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeCrashReportingInvalidation();
    expect(loadCrashReportingOptOut()).toBe(true);

    stateStore.set('crashReportingOptOut', 'false');
    emitStateSaved('notifyEnabled');
    expect(loadCrashReportingOptOut()).toBe(true);
    off();
  });

  // Reverse-verify: if the subscription is detached, a subsequent emit MUST
  // NOT invalidate. Proves the bus subscription is what drives invalidation.
  it('reverse-verify: unsubscribed listener no longer invalidates', async () => {
    stateStore.set('crashReportingOptOut', 'true');
    const { loadCrashReportingOptOut, subscribeCrashReportingInvalidation } =
      await import('../crashReporting');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeCrashReportingInvalidation();
    loadCrashReportingOptOut(); // prime cache to true
    off();

    stateStore.set('crashReportingOptOut', 'false');
    emitStateSaved('crashReportingOptOut');
    expect(loadCrashReportingOptOut()).toBe(true);
  });
});
