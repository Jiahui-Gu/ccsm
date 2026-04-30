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

beforeEach(async () => {
  stateStore.clear();
  throwOnLoad = false;
  // Reset the module-local cache between tests by resetting modules and
  // re-importing in each test that needs it.
  vi.resetModules();
});

describe('loadNotifyEnabled', () => {
  it('defaults ON when the row is missing', async () => {
    const { loadNotifyEnabled } = await import('../notifyEnabled');
    expect(loadNotifyEnabled()).toBe(true);
  });
  it('returns true for non-explicit-off values', async () => {
    stateStore.set('notifyEnabled', 'true');
    const { loadNotifyEnabled } = await import('../notifyEnabled');
    expect(loadNotifyEnabled()).toBe(true);
  });
  it('returns false for explicit "false"', async () => {
    stateStore.set('notifyEnabled', 'false');
    const { loadNotifyEnabled } = await import('../notifyEnabled');
    expect(loadNotifyEnabled()).toBe(false);
  });
  it('returns false for "0"', async () => {
    stateStore.set('notifyEnabled', '0');
    const { loadNotifyEnabled } = await import('../notifyEnabled');
    expect(loadNotifyEnabled()).toBe(false);
  });
  it('defaults true when loadState throws', async () => {
    throwOnLoad = true;
    const { loadNotifyEnabled } = await import('../notifyEnabled');
    expect(loadNotifyEnabled()).toBe(true);
  });
  it('caches after first read; cache invalidation re-reads', async () => {
    stateStore.set('notifyEnabled', 'false');
    const { loadNotifyEnabled, invalidateNotifyEnabledCache } = await import(
      '../notifyEnabled'
    );
    expect(loadNotifyEnabled()).toBe(false);

    // Mutate the underlying store; cached value should still report false.
    stateStore.set('notifyEnabled', 'true');
    expect(loadNotifyEnabled()).toBe(false);

    // After invalidation, the next read picks up the new value.
    invalidateNotifyEnabledCache();
    expect(loadNotifyEnabled()).toBe(true);
  });
});

// Task #818 / tech-debt-12 leak #5: cache invalidation predicate now lives
// in this module and subscribes to the stateSavedBus rather than being
// dispatched by the db:save handler. These tests verify the wiring.
describe('subscribeNotifyEnabledInvalidation', () => {
  it('invalidates the cache when stateSavedBus emits NOTIFY_ENABLED_KEY', async () => {
    stateStore.set('notifyEnabled', 'false');
    const { loadNotifyEnabled, subscribeNotifyEnabledInvalidation } =
      await import('../notifyEnabled');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeNotifyEnabledInvalidation();
    expect(loadNotifyEnabled()).toBe(false);

    // A renderer save flips the underlying value AND emits the bus event.
    stateStore.set('notifyEnabled', 'true');
    emitStateSaved('notifyEnabled');
    expect(loadNotifyEnabled()).toBe(true);
    off();
  });

  it('ignores unrelated keys', async () => {
    stateStore.set('notifyEnabled', 'false');
    const { loadNotifyEnabled, subscribeNotifyEnabledInvalidation } =
      await import('../notifyEnabled');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeNotifyEnabledInvalidation();
    expect(loadNotifyEnabled()).toBe(false);

    // An unrelated key save must NOT invalidate this cache.
    stateStore.set('notifyEnabled', 'true');
    emitStateSaved('crashReportingOptOut');
    expect(loadNotifyEnabled()).toBe(false);
    off();
  });

  // Reverse-verify: if the subscription is detached, a subsequent emit MUST
  // NOT invalidate. Proves the bus subscription is what drives invalidation
  // (not some other side path).
  it('reverse-verify: unsubscribed listener no longer invalidates', async () => {
    stateStore.set('notifyEnabled', 'false');
    const { loadNotifyEnabled, subscribeNotifyEnabledInvalidation } =
      await import('../notifyEnabled');
    const { emitStateSaved, _resetStateSavedBusForTests } = await import(
      '../../shared/stateSavedBus'
    );
    _resetStateSavedBusForTests();
    const off = subscribeNotifyEnabledInvalidation();
    loadNotifyEnabled(); // prime cache to false
    off();

    stateStore.set('notifyEnabled', 'true');
    emitStateSaved('notifyEnabled');
    // Cache still reports the stale value because the listener was removed.
    expect(loadNotifyEnabled()).toBe(false);
  });
});
