import { describe, it, expect } from 'vitest';
import { createInstallerSlice } from '../../../src/stores/slices/installerSlice';
import type { RootStore } from '../../../src/stores/slices/types';

function harness() {
  let state: Partial<RootStore> = {};
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const slice = createInstallerSlice(set, get);
  state = { ...state, ...slice };
  return { state: () => state, slice };
}

describe('installerSlice', () => {
  it('initial state', () => {
    const h = harness();
    const s = h.state();
    expect(s.claudeSettingsDefaultModel).toBeNull();
    expect(s.installerCorrupt).toBe(false);
  });

  it('setInstallerCorrupt toggles the banner flag', () => {
    const h = harness();
    h.slice.setInstallerCorrupt(true);
    expect(h.state().installerCorrupt).toBe(true);
    h.slice.setInstallerCorrupt(false);
    expect(h.state().installerCorrupt).toBe(false);
  });
});
