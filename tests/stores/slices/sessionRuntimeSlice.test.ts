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

  // Ref-stability regression guards for the sidebar perf path. The Sidebar
  // buckets sessions by groupId via useMemo([sessions]) and relies on
  // React.memo on GroupRow / SessionRow to short-circuit unrelated rows
  // when a single session's `state` toggles (waiting<->idle on JSONL
  // chunks). Both rely on the slice patching ONLY the changed session and
  // preserving every other session's reference via per-element map. If
  // that property regresses, the sidebar streaming-flicker bug returns.
  it('_applySessionState is a noop (same sessions ref) when state is unchanged', () => {
    const sessions = [mkSession('a', 'g1', { state: 'idle' })];
    const h = harness({ sessions, activeId: 'b' });
    const before = h.state().sessions;
    h.runtime._applySessionState('a', 'idle');
    // Same array ref — no subscriber notification, no persist scheduled.
    expect(h.state().sessions).toBe(before);
  });

  it('_applySessionState preserves untouched session refs on real change', () => {
    const a = mkSession('a', 'g1', { state: 'idle' });
    const b = mkSession('b', 'g1', { state: 'idle' });
    const c = mkSession('c', 'g2', { state: 'idle' });
    const h = harness({ sessions: [a, b, c], activeId: 'x' });
    h.runtime._applySessionState('b', 'waiting');
    const next = h.state().sessions;
    // `b` was patched — new object ref.
    expect(next[1]).not.toBe(b);
    expect(next[1].state).toBe('waiting');
    // `a` and `c` were untouched — same ref so React.memo on SessionRow
    // can short-circuit.
    expect(next[0]).toBe(a);
    expect(next[2]).toBe(c);
  });
});
