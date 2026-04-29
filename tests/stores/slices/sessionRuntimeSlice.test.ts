import { describe, it, expect } from 'vitest';
import { createSessionRuntimeSlice } from '../../../src/stores/slices/sessionRuntimeSlice';
import type { RootStore } from '../../../src/stores/slices/types';
import type { Session } from '../../../src/types';

// The runtime slice mutates `sessions` (state field) and owns
// `flashStates` + `disconnectedSessions`. Harness mounts only the
// runtime slice on a minimal root state — `_apply*` helpers don't
// reach into other slices.
function harness(initial?: Partial<RootStore>) {
  let state: Partial<RootStore> = {
    sessions: [],
    activeId: '',
    ...initial,
  };
  const set = (
    partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)
  ) => {
    const patch = typeof partial === 'function' ? partial(state as RootStore) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state as RootStore;
  const runtime = createSessionRuntimeSlice(set, get);
  state = { ...state, ...runtime, ...initial };
  return { state: () => state, runtime, set, get };
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

describe('sessionRuntimeSlice', () => {
  it('initial state', () => {
    const h = harness();
    expect(h.state().flashStates).toEqual({});
    expect(h.state().disconnectedSessions).toEqual({});
  });

  it('_applyCwdRedirect patches cwd; rejects empty', () => {
    const h = harness({ sessions: [mkSession('a', 'g1', { cwd: '/old' })] });
    h.runtime._applyCwdRedirect('a', '/new');
    expect(h.state().sessions[0].cwd).toBe('/new');
    h.runtime._applyCwdRedirect('a', '');
    expect(h.state().sessions[0].cwd).toBe('/new');
  });

  it('_applyPtyExit classifies clean vs crashed', () => {
    const h = harness({ sessions: [mkSession('a', 'g1')] });
    h.runtime._applyPtyExit('a', { code: 0, signal: null });
    expect(h.state().disconnectedSessions['a'].kind).toBe('clean');
    h.runtime._applyPtyExit('a', { code: 1, signal: null });
    expect(h.state().disconnectedSessions['a'].kind).toBe('crashed');
    h.runtime._clearPtyExit('a');
    expect(h.state().disconnectedSessions['a']).toBeUndefined();
  });

  it('_applySessionState suppresses waiting on the active session', () => {
    const h = harness({
      sessions: [mkSession('a', 'g1', { state: 'idle' })],
      activeId: 'a',
    });
    h.runtime._applySessionState('a', 'waiting');
    expect(h.state().sessions[0].state).toBe('idle');
    h.set({ activeId: 'b' });
    h.runtime._applySessionState('a', 'waiting');
    expect(h.state().sessions[0].state).toBe('waiting');
  });

  it('_setFlash adds and removes', () => {
    const h = harness();
    h.runtime._setFlash('a', true);
    expect(h.state().flashStates['a']).toBe(true);
    h.runtime._setFlash('a', false);
    expect(h.state().flashStates['a']).toBeUndefined();
  });
});
