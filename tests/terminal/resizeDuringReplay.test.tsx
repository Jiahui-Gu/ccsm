// F6 regression — pins the replay coalescing landed in PR #1308.
//
// Race: a window/pane resize fires ResizeObserver → 80ms debounce →
// ccsmPty.resize → snapshotReplay(). While that replay is still in flight
// (awaiting getBufferSnapshot), a SECOND ResizeObserver callback fires and
// runs its own resize cycle. The coalescing in `usePtyAttach.ts` (PR #1308)
// must funnel the second replay invocation through `replayPending` instead
// of starting a parallel runReplay — otherwise two interleaved
// reset()+write() sequences scribble over each other.
//
// We mount the REAL replay handler by spinning up usePtyAttach (which
// installs it via setSnapshotReplay) and trigger it via useTerminalResize.
// The fake pty bridge gates getBufferSnapshot on a manually-resolved
// promise so the test can hold the first replay open while firing the
// second resize.
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

const fakeTerm = createFakeTerminal({ cols: 100, rows: 30 });
const fakeFit = createFakeFit({ cols: 100, rows: 30 });

vi.mock('../../src/terminal/xtermSingleton', () =>
  createXtermSingletonMock(() => fakeTerm, () => fakeFit),
);

// Minimal store stub — usePtyAttach reads `_clearPtyExit` via selector and
// reaches into getState() for pendingForkSource.
const clearPtyExitSpy = vi.fn();
const mockStoreState: { pendingForkSource: Record<string, string> } = {
  pendingForkSource: {},
};
vi.mock('../../src/stores/store', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useStore = ((selector: (s: any) => any) =>
    selector({ _clearPtyExit: clearPtyExitSpy, ...mockStoreState })) as any;
  useStore.getState = () => ({ _clearPtyExit: clearPtyExitSpy, ...mockStoreState });
  useStore.setState = () => {};
  return { useStore };
});

import { usePtyAttach } from '../../src/terminal/usePtyAttach';
import { useTerminalResize } from '../../src/terminal/useTerminalResize';
import { __resetSingletonForTests } from '../../src/terminal/xtermSingleton';

// Capture the ResizeObserver callback so the test fires it manually.
let lastObserverCb: ResizeObserverCallback | null = null;
class ROStub implements ResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    lastObserverCb = cb;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('F6: resize-during-replay coalescing (PR #1308)', () => {
  let originalRO: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    __resetSingletonForTests();
    resetFakeTerminalSpies(fakeTerm);
    fakeTerm.cols = 100;
    fakeTerm.rows = 30;
    lastObserverCb = null;
    originalRO = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: typeof ROStub }).ResizeObserver = ROStub;
  });

  afterEach(() => {
    uninstallCcsmPty();
    __resetSingletonForTests();
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = originalRO;
  });

  it('second resize during in-flight replay is coalesced — getBufferSnapshot called once for the in-flight cycle and exactly once more for the queued one (no third parallel run)', async () => {
    // Two deferred snapshot responses so we can hold each replay open.
    type Snap = { snapshot: string; seq: number };
    const snapResolvers: Array<(v: Snap) => void> = [];
    const snapshotCalls: number[] = [];
    const ptyHarness = createPtyBridge({
      attach: { snapshot: 'attach-snap', cols: 100, rows: 30, pid: 1 },
    });
    // Override getBufferSnapshot to return manually-controlled promises.
    ptyHarness.bridge.getBufferSnapshot.mockImplementation(async (_sid: string) => {
      snapshotCalls.push(Date.now());
      return await new Promise<Snap>((r) => snapResolvers.push(r));
    });
    // resize returns immediately so useTerminalResize moves on to the replay.
    ptyHarness.bridge.resize.mockImplementation(async () => undefined);
    installCcsmPty(ptyHarness.bridge);

    // Mount usePtyAttach to install the production replay handler.
    const attachHook = renderHook(() => usePtyAttach('sid-A'));
    // Drain the initial attach (attach -> first snapshot fetch).
    // The initial attach's snapshot is fetched by usePtyAttach itself and
    // also goes through getBufferSnapshot — drain it first.
    await act(async () => {
      // Resolve the initial-attach snapshot fetch so usePtyAttach completes
      // its boot path and reaches setSnapshotReplay(...).
      await new Promise<void>((r) => setTimeout(r, 0));
      while (snapResolvers.length > 0) {
        const r = snapResolvers.shift()!;
        r({ snapshot: 'boot', seq: 0 });
      }
      await settleAttach();
    });
    const initialSnapshotCount = snapshotCalls.length;

    // Mount useTerminalResize so RO callbacks drive the snapshot-replay path.
    const host = document.createElement('div');
    const ref = { current: host };
    renderHook(() => useTerminalResize(ref));

    vi.useFakeTimers();
    // === Resize cycle #1 ===
    lastObserverCb!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    await vi.advanceTimersByTimeAsync(80);
    // useTerminalResize awaited resize() (resolved) and called replay().
    // replay() calls getBufferSnapshot — which is now pending on snapResolvers[0].
    vi.useRealTimers();
    // Microtasks for the resize().then(() => replay()) chain to actually
    // invoke getBufferSnapshot.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(snapshotCalls.length - initialSnapshotCount).toBe(1);
    expect(snapResolvers.length).toBe(1);

    // === Resize cycle #2 (while #1's replay is still awaiting snapshot) ===
    vi.useFakeTimers();
    lastObserverCb!([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    await vi.advanceTimersByTimeAsync(80);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // PIN: coalescing — replay #2 hits the `replayInFlight` branch and sets
    // `replayPending = true` without starting a parallel runReplay. So
    // getBufferSnapshot is STILL only called once total in this cycle (the
    // pending replay won't fetch until #1's snapshot resolves).
    expect(snapshotCalls.length - initialSnapshotCount).toBe(1);

    // Now resolve #1's snapshot. The in-flight replay completes its
    // runReplay, then the while-loop sees replayPending and runs ONE more
    // runReplay — which triggers a second getBufferSnapshot fetch.
    await act(async () => {
      snapResolvers.shift()!({ snapshot: 'snap1', seq: 1 });
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    expect(snapshotCalls.length - initialSnapshotCount).toBe(2);
    expect(snapResolvers.length).toBe(1);

    // Resolve the queued one to clean up.
    await act(async () => {
      snapResolvers.shift()!({ snapshot: 'snap2', seq: 2 });
      await settleAttach();
    });

    // PIN: total snapshot fetches from the two resize cycles is exactly 2,
    // never 3 — coalescing collapses the second request into the in-flight
    // run's post-completion drain rather than spawning a parallel fetch.
    expect(snapshotCalls.length - initialSnapshotCount).toBe(2);

    attachHook.unmount();
  });
});
