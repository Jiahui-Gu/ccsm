import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  createFakeTerminal,
  createFakeFit,
  createXtermSingletonMock,
  createPtyBridge,
  installCcsmPty,
  uninstallCcsmPty,
  resetFakeTerminalSpies,
  settleAttach,
} from '../util/terminalHarness';

// Shared terminal-hook test harness — see tests/util/terminalHarness.ts.
// `fakeTerm` and `fakeFit` are the assertion targets; `createXtermSingletonMock`
// is the factory for vi.mock's replacement of `xtermSingleton`.
const fakeTerm = createFakeTerminal();
const fakeFit = createFakeFit({ cols: 134, rows: 51 });

vi.mock('../../src/terminal/xtermSingleton', () =>
  createXtermSingletonMock(() => fakeTerm, () => fakeFit),
);

// Convenience locals so the assertion bodies below read naturally.
const writeSpy = fakeTerm.write;
const resetSpy = fakeTerm.reset;
const resizeSpy = fakeTerm.resize;
const focusSpy = fakeTerm.focus;
const scrollToBottomSpy = fakeTerm.scrollToBottom;
const onDataSpy = fakeTerm.onData;
const inputDisposableDispose = fakeTerm.inputDisposableDispose;
const callLog = fakeTerm.callLog;
const fitFitSpy = fakeFit.fit;
const proposeDimensionsSpy = fakeFit.proposeDimensions;

// Mock store — _clearPtyExit is the only piece usePtyAttach reads via the
// hook selector. The fork-on-spawn path (right-click "Copy session") also
// reaches into `useStore.getState().pendingForkSource[sid]` and calls
// `useStore.setState((s) => …)` to clear the entry post-spawn, so the mock
// must expose getState/setState statics on the same callable. Tests that
// need to seed a fork source push into `mockStoreState.pendingForkSource`.
const clearPtyExitSpy = vi.fn();
const mockStoreState: { pendingForkSource: Record<string, string> } = {
  pendingForkSource: {},
};
vi.mock('../../src/stores/store', () => {
  const useStore = ((selector: (s: any) => any) =>
    selector({ _clearPtyExit: clearPtyExitSpy, ...mockStoreState })) as any;
  useStore.getState = () => ({ _clearPtyExit: clearPtyExitSpy, ...mockStoreState });
  useStore.setState = (
    patch:
      | { pendingForkSource?: Record<string, string> }
      | ((s: typeof mockStoreState) => { pendingForkSource?: Record<string, string> } | {}),
  ) => {
    const next =
      typeof patch === 'function'
        ? patch({ ...mockStoreState })
        : patch;
    if (next && 'pendingForkSource' in next && next.pendingForkSource) {
      mockStoreState.pendingForkSource = next.pendingForkSource;
    }
  };
  return { useStore };
});

import { usePtyAttach } from '../../src/terminal/usePtyAttach';
import {
  __resetSingletonForTests,
  getActiveSid,
} from '../../src/terminal/xtermSingleton';

// `makePtyBridge` used to live in this file; it's now in the harness as
// `createPtyBridge`. Keep the legacy name as a thin alias so the test
// bodies below don't all have to be rewritten in this PR.
const makePtyBridge = createPtyBridge;

// `flushAll` is a thin wrapper around the named harness helper — same
// behavior (three setTimeout-0 yields inside an `act`), but the harness
// version documents what's being drained (usePtyAttach's await chain).
const flushAll = (): Promise<void> => settleAttach({ wrap: act });
// One-shot microtask yield, used inline in tests for "let one await tick".
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('usePtyAttach', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    resetFakeTerminalSpies(fakeTerm);
    fakeTerm.cols = 80;
    fakeTerm.rows = 24;
    fitFitSpy.mockClear();
    proposeDimensionsSpy.mockClear();
    proposeDimensionsSpy.mockReturnValue({ cols: 134, rows: 51 });
    clearPtyExitSpy.mockClear();
    mockStoreState.pendingForkSource = {};
  });

  afterEach(() => {
    uninstallCcsmPty();
    __resetSingletonForTests();
  });

  it('attaches on mount: writes snapshot, subscribes onData, sets activeSid, ready state', async () => {
    const { bridge, spies } = makePtyBridge();
    installCcsmPty(bridge);

    const { result } = renderHook(() => usePtyAttach('sid-A', '/tmp'));
    expect(result.current.state.kind).toBe('attaching');
    await flushAll();

    expect(spies.attach).toHaveBeenCalledWith('sid-A');
    expect(resetSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith('snap');
    expect(spies.onData).toHaveBeenCalled();
    expect(getActiveSid()).toBe('sid-A');
    expect(focusSpy).toHaveBeenCalled();
    expect(clearPtyExitSpy).toHaveBeenCalledWith('sid-A');
    expect(result.current.state.kind).toBe('ready');
  });

  it('on sessionId change: detaches previous, unsubscribes, re-attaches new', async () => {
    const { bridge, spies } = makePtyBridge();
    installCcsmPty(bridge);

    const { rerender, result } = renderHook(({ sid }) => usePtyAttach(sid, '/tmp'), {
      initialProps: { sid: 'sid-A' },
    });
    await flushAll();
    expect(getActiveSid()).toBe('sid-A');
    const firstUnsub = spies.onDataUnsub;
    spies.onDataUnsub.mockClear();

    await act(async () => {
      rerender({ sid: 'sid-B' });
      await flush();
      await flush();
    });

    expect(spies.detach).toHaveBeenCalledWith('sid-A');
    expect(firstUnsub).toHaveBeenCalled(); // previous onData subscription torn down
    expect(inputDisposableDispose).toHaveBeenCalled();
    expect(spies.attach).toHaveBeenCalledWith('sid-B');
    expect(getActiveSid()).toBe('sid-B');
    expect(result.current.state.kind).toBe('ready');
  });

  it('falls back to spawn when attach returns null', async () => {
    let calls = 0;
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'after-spawn', seq: 0 } });
    spies.attach.mockImplementation(async (_sid: string) => {
      calls += 1;
      if (calls === 1) return null;
      return { snapshot: 'ignored-now', cols: 80, rows: 24, pid: 1 };
    });
    installCcsmPty(bridge);

    renderHook(() => usePtyAttach('sid-C', '/cwd'));
    await flushAll();

    expect(spies.spawn).toHaveBeenCalledWith('sid-C', '/cwd', undefined);
    expect(spies.attach).toHaveBeenCalledTimes(2);
    // L4 PR-B (#865): the visible terminal paints the getBufferSnapshot
    // string, NOT the legacy attach.snapshot.
    expect(writeSpy).toHaveBeenCalledWith('after-spawn');
  });

  // Right-click "Copy session" → `copySession` registers `pendingForkSource[
  // newSid] = sourceSid`. usePtyAttach's spawn-on-null-attach fallback must
  // read it and pass `sourceSid` as the 3rd arg of `pty.spawn`, then clear
  // the entry so a subsequent Retry doesn't re-fire `--fork-session` against
  // an already-forked sid.
  it('forwards pendingForkSource[sid] as the 3rd spawn arg, then clears it post-spawn', async () => {
    let calls = 0;
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'forked', seq: 0 } });
    spies.attach.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return null;
      return { snapshot: 'ignored', cols: 80, rows: 24, pid: 1 };
    });
    installCcsmPty(bridge);
    mockStoreState.pendingForkSource = { 'sid-FORK': 'sid-SOURCE' };

    renderHook(() => usePtyAttach('sid-FORK', '/cwd'));
    await flushAll();

    expect(spies.spawn).toHaveBeenCalledWith('sid-FORK', '/cwd', 'sid-SOURCE');
    // Post-spawn: pendingForkSource entry for this sid is gone, so a
    // hypothetical re-spawn (Retry) wouldn't accidentally re-fork.
    expect(mockStoreState.pendingForkSource['sid-FORK']).toBeUndefined();
  });

  // L4 PR-F (#867) — the spawn-time cols/rows hack added for #852 has been
  // removed. The renderer no longer measures the viewport via FitAddon
  // before spawn nor forwards cols/rows to `pty.spawn`; the PTY launches at
  // the lifecycle defaults and the post-attach `pty.resize` + snapshot
  // replay (PR-D #866) reflows both the headless source-of-truth buffer
  // and the visible xterm to the real container size, so claude doesn't
  // need to voluntarily repaint its alt-screen for the user to see correct
  // content.
  it('does not forward cols/rows to spawn (#867 — PR-D resize+replay covers #852)', async () => {
    let calls = 0;
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'after-spawn', seq: 0 } });
    spies.attach.mockImplementation(async (_sid: string) => {
      calls += 1;
      if (calls === 1) return null;
      return { snapshot: 'ignored-now', cols: 120, rows: 30, pid: 1 };
    });
    installCcsmPty(bridge);

    renderHook(() => usePtyAttach('sid-867', '/cwd'));
    await flushAll();

    // Spawn is called with sid + cwd + an explicit `undefined` 3rd arg
    // (forkSourceSid). The 3rd arg is only set on the right-click "Copy
    // session" fork path; for the normal spawn-on-null-attach fallback it
    // must be undefined so main takes the standard `--session-id <sid>`
    // branch in `entryFactory.makeEntry`.
    expect(spies.spawn).toHaveBeenCalledWith('sid-867', '/cwd', undefined);
    // FitAddon.proposeDimensions is no longer called pre-spawn.
    expect(proposeDimensionsSpy).not.toHaveBeenCalled();
  });

  it('post-attach fit is a no-op when container size is stable: no replay, snapshot fetched once (#888)', async () => {
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'snap', seq: 0 } });
    installCcsmPty(bridge);

    // fitFitSpy default = does NOT mutate cols/rows → no size delta.
    renderHook(() => usePtyAttach('sid-867s', '/cwd'));
    await flushAll();

    // fit.fit() still runs (we need to measure), but because cols/rows are
    // unchanged the backend resize and snapshot replay must be skipped.
    expect(fitFitSpy).toHaveBeenCalled();
    expect(spies.resize).not.toHaveBeenCalled();
    // PR-D contract: only the initial attach snapshot was fetched / written.
    expect(spies.getBufferSnapshot).toHaveBeenCalledTimes(1);
  });

  it('post-attach fit triggers backend resize + snapshot replay when container size differs (#867 / #852)', async () => {
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'snap', seq: 0 } });
    installCcsmPty(bridge);

    // Simulate the real #852 case: visible viewport differs from spawn-time
    // 80x24 — fit.fit() reflows the term to a new size.
    fitFitSpy.mockImplementation(() => {
      fakeTerm.cols = 134;
      fakeTerm.rows = 51;
    });

    try {
      renderHook(() => usePtyAttach('sid-867r', '/cwd'));
      await flushAll();

      expect(fitFitSpy).toHaveBeenCalled();
      // Backend resize is pushed with the NEW dimensions (post-fit).
      expect(spies.resize).toHaveBeenCalledWith('sid-867r', 134, 51);
      // Replay handler ran → second getBufferSnapshot fetch (initial paint
      // + replay re-fetch).
      expect(spies.getBufferSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      // Restore fakeTerm dimensions for subsequent tests.
      fakeTerm.cols = 80;
      fakeTerm.rows = 24;
      fitFitSpy.mockReset();
    }
  });

  it('flips to error state when ccsmPty bridge is missing', async () => {
    delete (window as any).ccsmPty;
    const { result } = renderHook(() => usePtyAttach('sid-X', ''));
    await flushAll();
    expect(result.current.state).toEqual({ kind: 'error', message: 'ccsmPty unavailable' });
  });

  it('classifies pty exit: clean (code 0, no signal)', async () => {
    const { bridge, fire } = makePtyBridge();
    installCcsmPty(bridge);
    const { result } = renderHook(() => usePtyAttach('sid-D', ''));
    await flushAll();
    fire.exit({ sessionId: 'sid-D', code: 0, signal: null });
    await act(async () => {
      await flush();
    });
    expect(result.current.state).toMatchObject({ kind: 'exit', exitKind: 'clean' });
  });

  it('classifies pty exit: crashed (signal set)', async () => {
    const { bridge, fire } = makePtyBridge();
    installCcsmPty(bridge);
    const { result } = renderHook(() => usePtyAttach('sid-E', ''));
    await flushAll();
    fire.exit({ sessionId: 'sid-E', code: null, signal: 'SIGKILL' });
    await act(async () => {
      await flush();
    });
    expect(result.current.state).toMatchObject({ kind: 'exit', exitKind: 'crashed' });
  });

  // Regression: "attach a session, scrollbar lands at the top/middle of
  // the transcript" reported by user. Root cause: xterm's `write` is
  // queued via WriteBuffer; a synchronous scrollToBottom() after
  // `write(snapshot)` runs before baseY catches up to the snapshot's
  // line count, so the viewport stays parked at the post-`reset()` line
  // 0. Fix: park the viewport via `write('', cb)` rendezvous so the
  // scroll happens AFTER the WriteBuffer drains the snapshot.
  it('scrolls to bottom AFTER the snapshot write drain rendezvous fires', async () => {
    const { bridge } = makePtyBridge({ snapshot: { snapshot: 'snap-body', seq: 0 } });
    (window as any).ccsmPty = bridge;

    renderHook(() => usePtyAttach('sid-scroll', '/tmp'));
    await flushAll();

    // Snapshot was written.
    expect(writeSpy).toHaveBeenCalledWith('snap-body');
    // Scroll happened at least once.
    expect(scrollToBottomSpy).toHaveBeenCalled();
    // Crucial ordering: the rendezvous write('') landed BEFORE its cb
    // fired the scroll — i.e. scroll-to-bottom is NOT synchronous with
    // the snapshot write. With the fake's synchronous-callback `write`,
    // we expect to see `write:snap-body`, then `write:` (rendezvous),
    // then `scrollToBottom` in the log.
    const snapIdx = callLog.indexOf('write:snap-body');
    const rendezvousIdx = callLog.indexOf('write:', snapIdx + 1);
    const scrollIdx = callLog.indexOf('scrollToBottom', rendezvousIdx);
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(rendezvousIdx).toBeGreaterThan(snapIdx);
    expect(scrollIdx).toBeGreaterThan(rendezvousIdx);
  });

  // Same scroll-to-bottom contract for the snapshot-replay path (fired
  // by the post-attach fit branch when the container size differs from
  // the spawn dims, and by `useTerminalResize` after a SIGWINCH). Drives
  // the replay via the post-attach fit's container-size delta and
  // verifies a scroll happens after the replay's snapshot write drains.
  it('replay path scrolls to bottom after its snapshot drain (post-attach fit branch)', async () => {
    const { bridge, spies } = makePtyBridge({ snapshot: { snapshot: 'snap-A', seq: 0 } });
    (window as any).ccsmPty = bridge;
    // Force a size delta so the post-attach fit branch fires the replay.
    fitFitSpy.mockImplementation(() => {
      fakeTerm.cols = 134;
      fakeTerm.rows = 51;
    });
    // Different snapshot string for the replay so we can grep the log
    // independently of the initial attach snapshot.
    spies.getBufferSnapshot.mockImplementationOnce(async () => ({ snapshot: 'snap-A', seq: 0 }));
    spies.getBufferSnapshot.mockImplementationOnce(async () => ({ snapshot: 'replayed', seq: 1 }));

    try {
      renderHook(() => usePtyAttach('sid-replay', '/tmp'));
      await flushAll();

      expect(writeSpy).toHaveBeenCalledWith('replayed');
      const replayIdx = callLog.lastIndexOf('write:replayed');
      const scrollIdx = callLog.indexOf('scrollToBottom', replayIdx);
      expect(replayIdx).toBeGreaterThanOrEqual(0);
      expect(scrollIdx).toBeGreaterThan(replayIdx);
    } finally {
      fakeTerm.cols = 80;
      fakeTerm.rows = 24;
      fitFitSpy.mockReset();
    }
  });
});
