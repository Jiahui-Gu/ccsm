import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionTitleBackfillSlice } from '../../../src/stores/slices/sessionTitleBackfillSlice';
import type { RootStore } from '../../../src/stores/slices/types';
import type { Session } from '../../../src/types';

// Title backfill slice owns `_applyExternalTitle` (raw name patch) and
// `_backfillTitles` (one-shot SDK pull). Backfill consumes the patch
// helper via `get()._applyExternalTitle`, so the harness mounts only
// the backfill slice on a minimal root.
function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = {
    sessions: [],
    ...initial,
  };
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const titles = createSessionTitleBackfillSlice(set, get);
  state = { ...state, ...titles, ...initial };
  return { state: () => state, titles, set, get };
}

function mkSession(id: string, groupId: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    name: `s-${id}`,
    state: 'idle',
    cwd: '/tmp',
    model: '',
    groupId,
    agentType: 'claude-code',
    ...extra,
  };
}

describe('sessionTitleBackfillSlice', () => {
  beforeEach(() => {
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
  });
  afterEach(() => {
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
  });

  it('_applyExternalTitle patches matching session, no-op for unknowns', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'old' })],
    });
    h.titles._applyExternalTitle('a', 'new');
    expect(h.state().sessions[0].name).toBe('new');
    h.titles._applyExternalTitle('zzz', 'ignored');
    expect(h.state().sessions[0].name).toBe('new');
  });

  it('_applyExternalTitle is a no-op when name unchanged (reference stable)', () => {
    const h = harness({ sessions: [mkSession('a', 'g1', { name: 'same' })] });
    const before = h.state().sessions;
    h.titles._applyExternalTitle('a', 'same');
    expect(h.state().sessions).toBe(before);
  });

  it('_backfillTitles is a no-op when no bridge is present', async () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'New session', cwd: '/some/proj' })],
    });
    await h.titles._backfillTitles();
    // No bridge -> name remains the default placeholder.
    expect(h.state().sessions[0].name).toBe('New session');
  });
});
