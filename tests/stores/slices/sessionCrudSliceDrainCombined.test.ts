// F6 regression — pins the combined drain behaviour of deleteSession
// (audit #876 H2, sessionCrudSlice.ts:363-372). Existing tests in
// `sessionCrudSlice.test.ts` cover each map (flashStates,
// disconnectedSessions) individually and the no-op-on-other-sids case.
// This test combines both into a SINGLE deleteSession call so a future
// refactor that drains one map but not the other in the same code path
// is caught.
//
// Per F6 constraints we do not edit the existing slice test file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSessionCrudSlice } from '../../../src/stores/slices/sessionCrudSlice';
import { createGroupsSlice } from '../../../src/stores/slices/groupsSlice';
import type { RootStore } from '../../../src/stores/slices/types';
import type { Session } from '../../../src/types';

function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = { ...initial };
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore),
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const sessions = createSessionCrudSlice(set, get);
  const groups = createGroupsSlice(set, get);
  state = { ...state, ...sessions, ...groups, ...initial };
  return { state: () => state, sessions };
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

describe('F6: deleteSession drains BOTH per-sid maps in one call (audit #876 H2)', () => {
  beforeEach(() => {
    (window as unknown as { ccsmPty?: unknown }).ccsmPty = undefined;
  });
  afterEach(() => {
    (window as unknown as { ccsmPty?: unknown }).ccsmPty = undefined;
  });

  it('removes target sid from sessions, flashStates, AND disconnectedSessions while preserving an unrelated sid in both maps', () => {
    const h = harness({
      sessions: [mkSession('victim', 'g1'), mkSession('other', 'g1')],
      groups: [{ id: 'g1', name: 'g1', collapsed: false, kind: 'normal' }],
      activeId: 'victim',
      flashStates: { victim: true, other: true },
      disconnectedSessions: {
        victim: { kind: 'crashed', code: 1, signal: null, at: 100 },
        other: { kind: 'clean', code: 0, signal: null, at: 200 },
      },
    });

    h.sessions.deleteSession('victim');

    const s = h.state();
    // PIN 1: the session row is gone.
    expect(s.sessions.map((x) => x.id)).toEqual(['other']);
    // PIN 2: flashStates['victim'] drained (and only 'other' remains).
    expect(s.flashStates).toEqual({ other: true });
    // PIN 3: disconnectedSessions['victim'] drained (and 'other' is intact
    // with its original payload — proves the drain is keyed, not nuke-all).
    expect(s.disconnectedSessions).toEqual({
      other: { kind: 'clean', code: 0, signal: null, at: 200 },
    });
  });
});
