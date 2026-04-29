import { describe, it, expect } from 'vitest';
import { createPopoverSlice } from '../../../src/stores/slices/popoverSlice';
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
  const slice = createPopoverSlice(set, get);
  state = { ...state, ...slice };
  return { state: () => state, slice };
}

describe('popoverSlice', () => {
  it('starts with no open popover', () => {
    const h = harness();
    expect(h.state().openPopoverId).toBeNull();
  });

  it('openPopover sets the slot id', () => {
    const h = harness();
    h.slice.openPopover('cwd');
    expect(h.state().openPopoverId).toBe('cwd');
  });

  it('opening a different popover clobbers the previous one (mutex)', () => {
    const h = harness();
    h.slice.openPopover('cwd');
    h.slice.openPopover('model');
    expect(h.state().openPopoverId).toBe('model');
  });

  it('closePopover only clears its own id (idempotent stale-close guard)', () => {
    const h = harness();
    h.slice.openPopover('cwd');
    // A stale callback from a popover that was already superseded must
    // not clobber the new owner's slot.
    h.slice.closePopover('model');
    expect(h.state().openPopoverId).toBe('cwd');
    h.slice.closePopover('cwd');
    expect(h.state().openPopoverId).toBeNull();
  });

  it('closing when nothing is open is a no-op', () => {
    const h = harness();
    h.slice.closePopover('whatever');
    expect(h.state().openPopoverId).toBeNull();
  });

  it('reopening the same id keeps it (no-op)', () => {
    const h = harness();
    h.slice.openPopover('x');
    h.slice.openPopover('x');
    expect(h.state().openPopoverId).toBe('x');
  });
});
