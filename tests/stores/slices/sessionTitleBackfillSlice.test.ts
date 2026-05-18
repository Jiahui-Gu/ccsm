import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionTitleBackfillSlice } from '../../../src/stores/slices/sessionTitleBackfillSlice';
import {
  setPendingManualRename,
  _resetPendingManualRenamesForTests,
} from '../../../src/stores/lib/pendingManualRenames';
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
    _resetPendingManualRenamesForTests();
  });
  afterEach(() => {
    (window as unknown as { ccsmSessionTitles?: unknown }).ccsmSessionTitles = undefined;
    _resetPendingManualRenamesForTests();
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

  it('_applyExternalTitle drops stale auto-summary while a manual rename is pending', () => {
    // User just renamed sid 'a' to 'My label'; the titleEmitter races a
    // stale summary 'Old summary' before the JSONL rewrite lands. Without
    // the pending-manual-rename guard the user's name flicks back.
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'My label' })],
    });
    setPendingManualRename('a', 'My label');
    h.titles._applyExternalTitle('a', 'Old summary');
    expect(h.state().sessions[0].name).toBe('My label');
  });

  it('_applyExternalTitle clears the guard and applies once the SDK round-trips', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { name: 'My label' })],
    });
    setPendingManualRename('a', 'My label');
    // First the JSONL rewrite lands: external title matches desired -> guard clears.
    h.titles._applyExternalTitle('a', 'My label');
    expect(h.state().sessions[0].name).toBe('My label');
    // Later the user (or claude `/title`) legitimately changes it again.
    h.titles._applyExternalTitle('a', 'Renamed by claude');
    expect(h.state().sessions[0].name).toBe('Renamed by claude');
  });
});
