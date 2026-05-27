import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  describe('reloadSession', () => {
    let killSpy: ReturnType<typeof vi.fn>;
    let prevPty: unknown;
    beforeEach(() => {
      killSpy = vi.fn().mockResolvedValue({ ok: true, killed: true });
      prevPty = (window as unknown as { ccsmPty?: unknown }).ccsmPty;
      (window as unknown as { ccsmPty: unknown }).ccsmPty = { kill: killSpy };
    });
    afterEach(() => {
      (window as unknown as { ccsmPty: unknown }).ccsmPty = prevPty;
    });

    it('initial reloadNonce is empty', () => {
      const h = harness();
      expect(h.state().reloadNonce).toEqual({});
    });

    it('kills pty and bumps the per-session reloadNonce', async () => {
      const h = harness({ sessions: [mkSession('a', 'g1')] });
      await h.runtime.reloadSession('a');
      expect(killSpy).toHaveBeenCalledWith('a');
      expect(h.state().reloadNonce['a']).toBe(1);
      await h.runtime.reloadSession('a');
      expect(h.state().reloadNonce['a']).toBe(2);
    });

    it('clears any stale disconnect entry on reload', async () => {
      const h = harness({ sessions: [mkSession('a', 'g1')] });
      h.runtime._applyPtyExit('a', { code: 1, signal: null });
      expect(h.state().disconnectedSessions['a'].kind).toBe('crashed');
      await h.runtime.reloadSession('a');
      expect(h.state().disconnectedSessions['a']).toBeUndefined();
    });

    it('swallows kill IPC errors so the nonce still bumps', async () => {
      killSpy.mockRejectedValueOnce(new Error('not running'));
      const h = harness({ sessions: [mkSession('a', 'g1')] });
      await h.runtime.reloadSession('a');
      expect(h.state().reloadNonce['a']).toBe(1);
    });

    it('tolerates ccsmPty being undefined (test env)', async () => {
      (window as unknown as { ccsmPty: unknown }).ccsmPty = undefined;
      const h = harness({ sessions: [mkSession('a', 'g1')] });
      await h.runtime.reloadSession('a');
      expect(h.state().reloadNonce['a']).toBe(1);
    });

    // Bug: clicking "reload" on a healthy session was showing the
    // crashed-overlay because the OLD pty's kill produces an
    // asynchronous exit event that arrives at `_applyPtyExit` AFTER
    // `reloadSession` clears `disconnectedSessions`. Without
    // suppression, the slice re-populates with a stale crash entry
    // for the pty we ourselves killed, and `usePtyAttachShell`'s
    // disconnect watcher flips state to `exit` on top of the
    // freshly-spawned healthy pty.
    //
    // Contract: after `reloadSession`, the very next
    // `_applyPtyExit(sid, ...)` for the same sid is suppressed (the
    // kill we just issued is "expected"). Subsequent exits — e.g. the
    // NEW pty actually crashing later — flow through normally.
    it('arms expectedExits[sid] so the kill-induced exit is suppressed', async () => {
      const h = harness({ sessions: [mkSession('a', 'g1')] });
      await h.runtime.reloadSession('a');
      // After reload arms the counter, the OLD pty's exit event
      // (which would otherwise land here) is consumed silently.
      h.runtime._applyPtyExit('a', { code: 1, signal: null });
      expect(h.state().disconnectedSessions['a']).toBeUndefined();
      // Counter consumed: the NEXT exit (the new pty actually
      // crashing) IS recorded normally.
      h.runtime._applyPtyExit('a', { code: 137, signal: 'SIGKILL' });
      expect(h.state().disconnectedSessions['a']).toBeDefined();
      expect(h.state().disconnectedSessions['a'].kind).toBe('crashed');
    });

    it('each reload arms exactly one suppressed exit (counter stacks)', async () => {
      const h = harness({ sessions: [mkSession('a', 'g1')] });
      // User mashes reload twice while old pty is still being killed.
      await h.runtime.reloadSession('a');
      await h.runtime.reloadSession('a');
      // Both kill-exits are suppressed.
      h.runtime._applyPtyExit('a', { code: 1, signal: null });
      expect(h.state().disconnectedSessions['a']).toBeUndefined();
      h.runtime._applyPtyExit('a', { code: 1, signal: null });
      expect(h.state().disconnectedSessions['a']).toBeUndefined();
      // The third exit (new pty's genuine crash) IS recorded.
      h.runtime._applyPtyExit('a', { code: 1, signal: null });
      expect(h.state().disconnectedSessions['a']).toBeDefined();
    });

    // RED regression: the renderer wires TWO independent pty.onExit
    // listeners (App.tsx → usePtyExitBridge AND shellRegistry's module-
    // level installExitListenerOnce). A single main → renderer pty:exit
    // IPC therefore fans out to `_applyPtyExit` TWICE per sid. The
    // expectedExits counter only suppresses one call, so the second call
    // re-populates `disconnectedSessions[sid]` with a stale crash entry
    // for the pty we ourselves killed — surfacing the "claude crashed"
    // overlay on the freshly-spawned healthy session. This was the
    // user-visible bug after PR #1396's counter fix landed: green CI,
    // overlay still appeared in dev.
    //
    // The fix lives at the listener layer (shellRegistry stops
    // installing a second listener — see tests/terminal/shellRegistry
    // .test.ts "does NOT install a module-level pty.onExit listener").
    // The slice contract is preserved: exactly ONE post-reload exit
    // event is suppressed per `reloadSession` call.
    it('suppression is per-sid (other sids unaffected)', async () => {
      const h = harness({ sessions: [mkSession('a', 'g1'), mkSession('b', 'g1')] });
      await h.runtime.reloadSession('a');
      // Session b's exit is unrelated to a's reload and must surface.
      h.runtime._applyPtyExit('b', { code: 1, signal: null });
      expect(h.state().disconnectedSessions['b']).toBeDefined();
      expect(h.state().disconnectedSessions['a']).toBeUndefined();
    });
  });
});
