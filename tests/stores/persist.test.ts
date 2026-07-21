import { afterEach, describe, expect, it, vi } from 'vitest';
import { schedulePersist, type PersistedState } from '../../src/stores/persist';

const snapshot: PersistedState = {
  version: 1,
  sessions: [],
  groups: [],
  activeId: '',
};

afterEach(() => {
  vi.useRealTimers();
  delete (window as { ccsm?: unknown }).ccsm;
});

describe('schedulePersist', () => {
  it('drops a pending write when the preload bridge disappears before the debounce fires', async () => {
    vi.useFakeTimers();
    const saveState = vi.fn(async () => undefined);
    (window as { ccsm?: unknown }).ccsm = { saveState };

    schedulePersist(snapshot);
    delete (window as { ccsm?: unknown }).ccsm;

    await vi.advanceTimersByTimeAsync(250);
    expect(saveState).not.toHaveBeenCalled();
  });
});
