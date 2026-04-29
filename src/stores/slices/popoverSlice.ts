// Popover slice: global mutex slot for the currently-open popover/menu.
// Single string id (or null) — opening any popover implicitly closes the
// previous one. Idempotent close prevents stale "I should be closed now"
// callbacks from clobbering a freshly-opened popover.

import type { RootStore, SetFn, GetFn } from './types';

export type PopoverSlice = Pick<
  RootStore,
  'openPopoverId' | 'openPopover' | 'closePopover'
>;

export function createPopoverSlice(set: SetFn, _get: GetFn): PopoverSlice {
  return {
    openPopoverId: null,

    openPopover: (id) => {
      set((s) => (s.openPopoverId === id ? s : { openPopoverId: id }));
    },

    closePopover: (id) => {
      set((s) => (s.openPopoverId === id ? { openPopoverId: null } : s));
    },
  };
}
