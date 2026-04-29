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
