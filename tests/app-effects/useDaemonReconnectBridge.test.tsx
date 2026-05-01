import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useDaemonReconnectBridge,
  DAEMON_BOOT_CHANGED_EVENT,
  DAEMON_STREAM_DEAD_EVENT,
  type DaemonHealthSubscribe,
  type DaemonHealthSignal,
  type BootChangedDetail,
  type StreamDeadDetail,
} from '../../src/app-effects/useDaemonReconnectBridge';

describe('useDaemonReconnectBridge', () => {
  let signalCb: ((s: DaemonHealthSignal) => void) | null = null;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let subscribe: DaemonHealthSubscribe;
  let bootChangedSpy: ReturnType<typeof vi.fn>;
  let streamDeadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    unsubscribe = vi.fn();
    subscribe = vi.fn((cb: (s: DaemonHealthSignal) => void) => {
      signalCb = cb;
      return unsubscribe;
    });
    bootChangedSpy = vi.fn();
    streamDeadSpy = vi.fn();
    window.addEventListener(
      DAEMON_BOOT_CHANGED_EVENT,
      bootChangedSpy as EventListener,
    );
    window.addEventListener(
      DAEMON_STREAM_DEAD_EVENT,
      streamDeadSpy as EventListener,
    );
  });

  afterEach(() => {
    window.removeEventListener(
      DAEMON_BOOT_CHANGED_EVENT,
      bootChangedSpy as EventListener,
    );
    window.removeEventListener(
      DAEMON_STREAM_DEAD_EVENT,
      streamDeadSpy as EventListener,
    );
    signalCb = null;
  });

  it('subscribes on mount and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useDaemonReconnectBridge(subscribe));
    expect(subscribe).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when subscribe is null/undefined', () => {
    expect(() =>
      renderHook(() => useDaemonReconnectBridge(null)),
    ).not.toThrow();
    expect(() =>
      renderHook(() => useDaemonReconnectBridge(undefined)),
    ).not.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('records the first observed bootNonce silently (no event on first seen)', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ bootNonce: 'NONCE_A' });
    expect(bootChangedSpy).not.toHaveBeenCalled();
  });

  it('does not emit when bootNonce repeats unchanged', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ bootNonce: 'NONCE_A' });
    signalCb!({ bootNonce: 'NONCE_A' });
    signalCb!({ bootNonce: 'NONCE_A' });
    expect(bootChangedSpy).not.toHaveBeenCalled();
  });

  it('emits bootChanged with previous + new nonce on change', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ bootNonce: 'NONCE_A' });
    signalCb!({ bootNonce: 'NONCE_B' });
    expect(bootChangedSpy).toHaveBeenCalledTimes(1);
    const evt = bootChangedSpy.mock.calls[0][0] as CustomEvent<BootChangedDetail>;
    expect(evt.type).toBe(DAEMON_BOOT_CHANGED_EVENT);
    expect(evt.detail).toEqual({
      previousNonce: 'NONCE_A',
      newNonce: 'NONCE_B',
    });
  });

  it('advances cursor after change so subsequent same-nonce is silent', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ bootNonce: 'A' });
    signalCb!({ bootNonce: 'B' }); // emit #1
    signalCb!({ bootNonce: 'B' }); // silent
    signalCb!({ bootNonce: 'C' }); // emit #2
    expect(bootChangedSpy).toHaveBeenCalledTimes(2);
    const second = bootChangedSpy.mock.calls[1][0] as CustomEvent<BootChangedDetail>;
    expect(second.detail).toEqual({ previousNonce: 'B', newNonce: 'C' });
  });

  it('ignores empty-string bootNonce (defensive)', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ bootNonce: '' });
    signalCb!({ bootNonce: 'NONCE_A' }); // first real one — silent
    signalCb!({ bootNonce: 'NONCE_B' }); // emit
    expect(bootChangedSpy).toHaveBeenCalledTimes(1);
  });

  it('forwards streamDead 1:1 with sid + reason', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ streamDead: { sid: 'sess-1', reason: 'server-stream-dead' } });
    expect(streamDeadSpy).toHaveBeenCalledTimes(1);
    const evt = streamDeadSpy.mock.calls[0][0] as CustomEvent<StreamDeadDetail>;
    expect(evt.type).toBe(DAEMON_STREAM_DEAD_EVENT);
    expect(evt.detail).toEqual({
      sid: 'sess-1',
      reason: 'server-stream-dead',
    });
  });

  it('emits one streamDead per signal (no de-dup, T70 owns aggregation)', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ streamDead: { sid: 's1', reason: 'server-stream-dead' } });
    signalCb!({ streamDead: { sid: 's1', reason: 'server-stream-dead' } });
    signalCb!({ streamDead: { sid: 's2', reason: 'server-stream-dead' } });
    expect(streamDeadSpy).toHaveBeenCalledTimes(3);
  });

  it('handles a signal carrying both bootNonce change and streamDead', () => {
    renderHook(() => useDaemonReconnectBridge(subscribe));
    signalCb!({ bootNonce: 'A' });
    signalCb!({
      bootNonce: 'B',
      streamDead: { sid: 's1', reason: 'server-stream-dead' },
    });
    expect(bootChangedSpy).toHaveBeenCalledTimes(1);
    expect(streamDeadSpy).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes when subscribe identity changes', () => {
    const sub2 = vi.fn(() => vi.fn());
    const { rerender } = renderHook(
      ({ s }: { s: DaemonHealthSubscribe }) => useDaemonReconnectBridge(s),
      { initialProps: { s: subscribe } },
    );
    expect(subscribe).toHaveBeenCalledTimes(1);
    rerender({ s: sub2 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub2).toHaveBeenCalledTimes(1);
  });
});
