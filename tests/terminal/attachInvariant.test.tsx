// Attach-complete viewport-pinning invariant.
//
// Contract (see `pinViewportToBottom` in src/terminal/usePtyAttach.ts):
//   At the point where `usePtyAttach` reports `state:'ready'`, the visible
//   xterm viewport MUST equal baseY (view pinned at bottom of scrollback).
//
// History: the prior code only re-scrolled inside `runReplay()`, which was
// gated on `ptyResized=true`. An idle-target re-attach (no resize, tiny
// post-attach firstWrite) had no unconditional post-fit scroll and landed
// with viewport stranded at scroll-top. The rendezvous step before
// `state:ready` enforces the invariant unconditionally and emits the
// `attach.invariant.pinned` event so a future regression of this class is
// visible without re-diagnosis.
//
// This file asserts the rendezvous fires (and emits with atBottom:true) on
// every attach path: first-attach, switch-attach, retry, reload,
// ptyResized=true, ptyResized=false, and the fit-throw recovery path.
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

const fakeTerm = createFakeTerminal();
const fakeFit = createFakeFit({ cols: 134, rows: 51 });

vi.mock('../../src/terminal/xtermSingleton', () =>
  createXtermSingletonMock(() => fakeTerm, () => fakeFit),
);

// Capture `log.event` calls so we can assert the rendezvous fired and the
// `attach.invariant.pinned` payload reports atBottom:true. The real logger
// scrubs + writes to disk; the contract we care about here is "the event
// was emitted with atBottom:true at attach-complete".
const eventSpy = vi.fn();
vi.mock('../../src/shared/log', () => ({
  log: { event: (name: string, fields: Record<string, unknown>) => eventSpy(name, fields) },
  warn: vi.fn(),
}));

// Mock store — see tests/terminal/usePtyAttach.test.tsx for shape rationale.
const clearPtyExitSpy = vi.fn();
const mockStoreState: { pendingForkSource: Record<string, string>; reloadNonce: Record<string, number> } = {
  pendingForkSource: {},
  reloadNonce: {},
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
    const next = typeof patch === 'function' ? patch({ ...mockStoreState }) : patch;
    if (next && 'pendingForkSource' in next && next.pendingForkSource) {
      mockStoreState.pendingForkSource = next.pendingForkSource;
    }
  };
  return { useStore };
});

import { usePtyAttach } from '../../src/terminal/usePtyAttach';
import { __resetSingletonForTests } from '../../src/terminal/xtermSingleton';

const makePtyBridge = createPtyBridge;
const flushAll = (): Promise<void> => settleAttach({ wrap: act });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Last `attach.invariant.pinned` event payload from the spy, or undefined.
function lastPinnedEvent(): Record<string, unknown> | undefined {
  for (let i = eventSpy.mock.calls.length - 1; i >= 0; i -= 1) {
    const [name, fields] = eventSpy.mock.calls[i];
    if (name === 'attach.invariant.pinned') return fields as Record<string, unknown>;
  }
  return undefined;
}

// Count `attach.invariant.pinned` emissions so we can detect multi-attach.
function countPinned(): number {
  return eventSpy.mock.calls.filter((c) => c[0] === 'attach.invariant.pinned').length;
}

// Model "viewport drifted off bottom" so the test would FAIL without the
// pin: every `write(non-empty)` advances baseY past viewportY, mimicking
// xterm appending lines while the user-scrolled latch is set.
function installDriftingWrite(): void {
  fakeTerm.write.mockImplementation((data: string, cb?: () => void) => {
    fakeTerm.callLog.push(`write:${data}`);
    if (data.length > 0) {
      // Snapshot wrote N rows; pretend baseY advanced but viewportY didn't.
      fakeTerm.buffer.active.baseY = 72;
      fakeTerm.buffer.active.length = 145;
      fakeTerm.buffer.active.cursorY = 50;
    }
    if (cb) cb();
  });
  // The single source of truth for "follow live output": scrollToBottom
  // sets viewportY := baseY. Without the rendezvous step, baseY stays at
  // 72 while viewportY remains 0 — atBottom would be false.
  fakeTerm.scrollToBottom.mockImplementation(() => {
    fakeTerm.callLog.push('scrollToBottom');
    fakeTerm.buffer.active.viewportY = fakeTerm.buffer.active.baseY;
  });
}

describe('attach viewport-pinning invariant', () => {
  beforeEach(() => {
    __resetSingletonForTests();
    resetFakeTerminalSpies(fakeTerm);
    fakeTerm.cols = 80;
    fakeTerm.rows = 24;
    fakeFit.fit.mockClear();
    fakeFit.proposeDimensions.mockClear();
    fakeFit.proposeDimensions.mockReturnValue({ cols: 134, rows: 51 });
    eventSpy.mockClear();
    clearPtyExitSpy.mockClear();
    mockStoreState.pendingForkSource = {};
    mockStoreState.reloadNonce = {};
    installDriftingWrite();
  });

  afterEach(() => {
    uninstallCcsmPty();
    __resetSingletonForTests();
  });

  it('first-attach path: emits attach.invariant.pinned with atBottom:true (ptyResized=false)', async () => {
    const { bridge } = makePtyBridge();
    installCcsmPty(bridge);

    const { result } = renderHook(() => usePtyAttach('sid-first', '/tmp'));
    await flushAll();

    expect(result.current.state.kind).toBe('ready');
    const ev = lastPinnedEvent();
    expect(ev).toBeDefined();
    expect(ev?.sid).toBe('sid-first');
    expect(ev?.atBottom).toBe(true);
    expect(ev?.viewportY).toBe(72);
    expect(ev?.baseY).toBe(72);
    // Bounded-enum + scalar shape for the new fields.
    expect(['normal', 'alternate']).toContain(ev?.bufferType);
    expect(typeof ev?.cursorY).toBe('number');
    expect(typeof ev?.length).toBe('number');
  });

  it('switch-attach path (prev sid existed): rendezvous fires for new sid', async () => {
    const { bridge } = makePtyBridge();
    installCcsmPty(bridge);

    const { rerender, result } = renderHook(({ sid }) => usePtyAttach(sid, '/tmp'), {
      initialProps: { sid: 'sid-A' },
    });
    await flushAll();
    expect(countPinned()).toBe(1);
    expect(lastPinnedEvent()?.sid).toBe('sid-A');

    await act(async () => {
      rerender({ sid: 'sid-B' });
      await flush();
      await flush();
      await flush();
    });
    expect(result.current.state.kind).toBe('ready');
    expect(countPinned()).toBe(2);
    expect(lastPinnedEvent()?.sid).toBe('sid-B');
    expect(lastPinnedEvent()?.atBottom).toBe(true);
  });

  it('retry path (same sid, attachNonce bumped via onRetry): rendezvous fires again', async () => {
    const { bridge } = makePtyBridge();
    installCcsmPty(bridge);

    const { result } = renderHook(() => usePtyAttach('sid-retry', '/tmp'));
    await flushAll();
    expect(countPinned()).toBe(1);

    await act(async () => {
      result.current.onRetry();
      await flush();
      await flush();
      await flush();
    });
    expect(countPinned()).toBe(2);
    expect(lastPinnedEvent()?.atBottom).toBe(true);
  });

  it('reload path (reloadNonce bumped): rendezvous fires again', async () => {
    const { bridge } = makePtyBridge();
    installCcsmPty(bridge);

    const { rerender } = renderHook(({ nonce }) => {
      mockStoreState.reloadNonce = { 'sid-reload': nonce };
      return usePtyAttach('sid-reload', '/tmp');
    }, { initialProps: { nonce: 0 } });
    await flushAll();
    expect(countPinned()).toBe(1);

    await act(async () => {
      rerender({ nonce: 1 });
      await flush();
      await flush();
      await flush();
    });
    expect(countPinned()).toBe(2);
    expect(lastPinnedEvent()?.atBottom).toBe(true);
  });

  it('ptyResized=true path: rendezvous fires AFTER the resize+replay branch', async () => {
    const { bridge } = makePtyBridge({ snapshot: { snapshot: 'snap', seq: 0 } });
    installCcsmPty(bridge);
    // Force a size delta — fit.fit() reflows the term, so newCols/newRows
    // diverge from the attach.cols/rows and the ptyResized branch runs.
    fakeFit.fit.mockImplementation(() => {
      fakeTerm.cols = 134;
      fakeTerm.rows = 51;
    });

    try {
      renderHook(() => usePtyAttach('sid-resized', '/tmp'));
      await flushAll();
      const ev = lastPinnedEvent();
      expect(ev).toBeDefined();
      expect(ev?.atBottom).toBe(true);
      // The rendezvous emits AFTER the post-fit replay's scrollToBottom.
      // We use the event-call index as a coarse ordering check.
      const replayScrollIdx = eventSpy.mock.calls.findIndex(
        (c) => c[0] === 'attach.scrollToBottom.invoked' && (c[1] as any).callsite === 'post-fit',
      );
      const pinIdx = eventSpy.mock.calls.findIndex(
        (c) => c[0] === 'attach.invariant.pinned',
      );
      expect(replayScrollIdx).toBeGreaterThanOrEqual(0);
      expect(pinIdx).toBeGreaterThan(replayScrollIdx);
    } finally {
      fakeTerm.cols = 80;
      fakeTerm.rows = 24;
      fakeFit.fit.mockReset();
    }
  });

  it('ptyResized=false path (the empirical user repro): rendezvous fires unconditionally', async () => {
    // This is the bad attach from the bug report: snapshot applied, post-
    // snap scroll, fit applied with ptyResized=false, then state:ready —
    // and historically no post-fit scrollToBottom emission. The fix makes
    // the rendezvous unconditional. Assert it ran AND atBottom:true.
    const { bridge } = makePtyBridge();
    installCcsmPty(bridge);
    // fakeFit.fit default does NOT mutate cols/rows → ptyResized=false.

    renderHook(() => usePtyAttach('sid-idle', '/tmp'));
    await flushAll();

    // Pre-fix behavior: only the post-snap scrollToBottom would have
    // fired, and any subsequent baseY advance (a 12-byte cursor chunk
    // landing post-attach) would leave atBottom=false. The unconditional
    // rendezvous emits the invariant event regardless.
    const ev = lastPinnedEvent();
    expect(ev).toBeDefined();
    expect(ev?.sid).toBe('sid-idle');
    expect(ev?.atBottom).toBe(true);

    // No post-fit attach.scrollToBottom.invoked is expected (that
    // emission lives inside runReplay, gated on ptyResized=true).
    const postFitScroll = eventSpy.mock.calls.find(
      (c) => c[0] === 'attach.scrollToBottom.invoked' && (c[1] as any).callsite === 'post-fit',
    );
    expect(postFitScroll).toBeUndefined();
  });

  it('fit.fit() throws: rendezvous still pins viewport before state:ready', async () => {
    // Contract choice (see spec): on fit throw, the attach state still
    // transitions to ready (the visible terminal is still attached and
    // can render content), but the pinning rendezvous MUST run so the
    // user doesn't land on a stranded viewport.
    const { bridge } = makePtyBridge();
    installCcsmPty(bridge);
    fakeFit.fit.mockImplementation(() => {
      throw new Error('fit boom');
    });

    try {
      const { result } = renderHook(() => usePtyAttach('sid-fitthrow', '/tmp'));
      await flushAll();
      // Recovery path: still reaches ready.
      expect(result.current.state.kind).toBe('ready');
      const ev = lastPinnedEvent();
      expect(ev).toBeDefined();
      expect(ev?.sid).toBe('sid-fitthrow');
      expect(ev?.atBottom).toBe(true);
    } finally {
      fakeFit.fit.mockReset();
    }
  });
});
