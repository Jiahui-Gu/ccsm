import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store';

// T9 store-level invariants. Kept separate from Sidebar.test.tsx so a
// regression in the store fails with a tight, layout-free diagnosis.

function reset(): void {
  useStore.setState({
    token: 'test-token',
    sessions: [],
    activeSid: null,
    status: 'idle',
  });
}

describe('store — multi-session table (T9 / #656)', () => {
  beforeEach(() => {
    reset();
  });

  it('addSession appends and auto-promotes to active', () => {
    const { addSession } = useStore.getState();
    addSession({ sid: 's1', createdAt: 1, alive: true });
    let state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['s1']);
    expect(state.activeSid).toBe('s1');

    addSession({ sid: 's2', createdAt: 2, alive: true });
    state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['s1', 's2']);
    // Newest becomes active — preserves the single-session bootstrap UX
    // (the user expects to land on the session they just created).
    expect(state.activeSid).toBe('s2');
  });

  it('addSession with a duplicate sid is idempotent (no double row, just promote)', () => {
    const { addSession } = useStore.getState();
    addSession({ sid: 's1', createdAt: 1, alive: true });
    addSession({ sid: 's2', createdAt: 2, alive: true });
    addSession({ sid: 's1', createdAt: 1, alive: true });
    const state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['s1', 's2']);
    expect(state.activeSid).toBe('s1');
  });

  it('setActive switches activeSid only when the sid is known', () => {
    const { addSession, setActive } = useStore.getState();
    addSession({ sid: 's1', createdAt: 1, alive: true });
    addSession({ sid: 's2', createdAt: 2, alive: true });

    setActive('s1');
    expect(useStore.getState().activeSid).toBe('s1');

    // Unknown sid is rejected (defensive — protects MainPane from
    // ws-attaching to a phantom sid).
    setActive('does-not-exist');
    expect(useStore.getState().activeSid).toBe('s1');

    // null clears the active pointer (used after closeSession on the last row).
    setActive(null);
    expect(useStore.getState().activeSid).toBeNull();
  });

  it('closeSession removes the row and rotates active to the slot-successor', () => {
    const { addSession, setActive, closeSession } = useStore.getState();
    addSession({ sid: 's1', createdAt: 1, alive: true });
    addSession({ sid: 's2', createdAt: 2, alive: true });
    addSession({ sid: 's3', createdAt: 3, alive: true });
    setActive('s2');

    closeSession('s2');
    let state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['s1', 's3']);
    // s2 was at index 1; s3 took its slot, so s3 becomes active.
    expect(state.activeSid).toBe('s3');

    // Closing a non-active row leaves activeSid alone.
    closeSession('s1');
    state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['s3']);
    expect(state.activeSid).toBe('s3');

    // Closing the last surviving row clears activeSid.
    closeSession('s3');
    state = useStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.activeSid).toBeNull();
  });

  it('closeSession is a no-op on unknown sid', () => {
    const { addSession, closeSession } = useStore.getState();
    addSession({ sid: 's1', createdAt: 1, alive: true });
    closeSession('ghost');
    const state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['s1']);
    expect(state.activeSid).toBe('s1');
  });
});
