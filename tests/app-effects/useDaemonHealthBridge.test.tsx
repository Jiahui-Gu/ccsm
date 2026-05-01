import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useDaemonHealthBridge,
  __createDaemonHealthStoreForTest,
  type DaemonHealthStore,
} from '../../src/app-effects/useDaemonHealthBridge';
import { DaemonEventBus } from '../../src/lib/daemon-events';

describe('useDaemonHealthBridge', () => {
  let bus: DaemonEventBus;
  let store: DaemonHealthStore;
  let now: number;

  beforeEach(() => {
    bus = new DaemonEventBus();
    now = 1_000_000;
    store = __createDaemonHealthStoreForTest(bus, () => now);
  });

  it('subscribes to bus exactly ONCE per event regardless of consumer count', () => {
    // Render the hook from 5 independent consumers. Single bus
    // subscription is the whole point of consolidation.
    const r1 = renderHook(() => useDaemonHealthBridge(store));
    const r2 = renderHook(() => useDaemonHealthBridge(store));
    const r3 = renderHook(() => useDaemonHealthBridge(store));
    const r4 = renderHook(() => useDaemonHealthBridge(store));
    const r5 = renderHook(() => useDaemonHealthBridge(store));
    // 4 = one listener per event (bootChanged/streamDead/reconnected/unreachable).
    expect(store.getBusSubscriptionCount()).toBe(4);
    r1.unmount();
    r2.unmount();
    r3.unmount();
    r4.unmount();
    expect(store.getBusSubscriptionCount()).toBe(4);
    r5.unmount();
    // Last consumer left → bus listeners detached.
    expect(store.getBusSubscriptionCount()).toBe(0);
  });

  it('initial snapshot has unknown status and zeroed counters', () => {
    const { result } = renderHook(() => useDaemonHealthBridge(store));
    expect(result.current).toEqual({
      status: 'unknown',
      lastSeen: null,
      reconnectAttempt: 0,
      version: null,
      lastUnreachableReason: null,
      lastStreamDeadSubId: null,
    });
  });

  it('exposes ALL fields on bootChanged: status=healthy, version, lastSeen', () => {
    const { result } = renderHook(() => useDaemonHealthBridge(store));
    act(() => {
      now = 2_000_000;
      bus.emit('bootChanged', { bootNonce: 'BOOT-A' });
    });
    expect(result.current.status).toBe('healthy');
    expect(result.current.version).toBe('BOOT-A');
    expect(result.current.lastSeen).toBe(2_000_000);
    expect(result.current.reconnectAttempt).toBe(0);
  });

  it('streamDead bumps reconnectAttempt and downgrades status to degraded', () => {
    const { result } = renderHook(() => useDaemonHealthBridge(store));
    act(() => {
      bus.emit('bootChanged', { bootNonce: 'BOOT-A' });
    });
    expect(result.current.status).toBe('healthy');
    act(() => {
      bus.emit('streamDead', { subId: 'sess-1', lastSeq: 10, reason: 'x' });
    });
    expect(result.current.status).toBe('degraded');
    expect(result.current.reconnectAttempt).toBe(1);
    expect(result.current.lastStreamDeadSubId).toBe('sess-1');
    act(() => {
      bus.emit('streamDead', { subId: 'sess-2', lastSeq: 5, reason: 'x' });
    });
    expect(result.current.reconnectAttempt).toBe(2);
    expect(result.current.lastStreamDeadSubId).toBe('sess-2');
  });

  it('unreachable wins over degraded; reconnected restores to healthy', () => {
    const { result } = renderHook(() => useDaemonHealthBridge(store));
    act(() => {
      bus.emit('streamDead', { subId: 's1', reason: 'x' });
    });
    expect(result.current.status).toBe('degraded');
    act(() => {
      bus.emit('unreachable', { reason: 'rpc gone' });
    });
    expect(result.current.status).toBe('unreachable');
    expect(result.current.lastUnreachableReason).toBe('rpc gone');
    // streamDead should NOT downgrade from unreachable.
    act(() => {
      bus.emit('streamDead', { subId: 's2', reason: 'x' });
    });
    expect(result.current.status).toBe('unreachable');
    act(() => {
      bus.emit('reconnected', { bootNonce: 'BOOT-B' });
    });
    expect(result.current.status).toBe('healthy');
    expect(result.current.version).toBe('BOOT-B');
    expect(result.current.lastUnreachableReason).toBeNull();
  });

  it('snapshot identity is stable when no event has fired since last read', () => {
    const { result, rerender } = renderHook(() => useDaemonHealthBridge(store));
    const first = result.current;
    rerender();
    rerender();
    // No events → identical snapshot reference (required by
    // useSyncExternalStore to avoid render loops).
    expect(result.current).toBe(first);
  });

  it('all consumers see the same snapshot after one event', () => {
    const r1 = renderHook(() => useDaemonHealthBridge(store));
    const r2 = renderHook(() => useDaemonHealthBridge(store));
    const r3 = renderHook(() => useDaemonHealthBridge(store));
    act(() => {
      bus.emit('bootChanged', { bootNonce: 'X' });
    });
    expect(r1.result.current.version).toBe('X');
    expect(r2.result.current.version).toBe('X');
    expect(r3.result.current.version).toBe('X');
    // Identity is shared too — single source of truth.
    expect(r1.result.current).toBe(r2.result.current);
    expect(r2.result.current).toBe(r3.result.current);
    r1.unmount();
    r2.unmount();
    r3.unmount();
  });

  it('cleans up on last unmount: no events delivered after teardown', () => {
    const { result, unmount } = renderHook(() => useDaemonHealthBridge(store));
    act(() => {
      bus.emit('bootChanged', { bootNonce: 'A' });
    });
    expect(result.current.version).toBe('A');
    unmount();
    expect(store.getBusSubscriptionCount()).toBe(0);
    // Emitting after teardown is a no-op for the store; nothing throws.
    expect(() => bus.emit('bootChanged', { bootNonce: 'B' })).not.toThrow();
  });

  it('reverse-verify: returns initial snapshot when bus emits nothing', () => {
    // Verifies the test's own discriminating power — without any bus
    // emission, the snapshot fields stay at their initial values. If
    // we accidentally inverted any default, this catches it.
    const { result } = renderHook(() => useDaemonHealthBridge(store));
    expect(result.current.status).toBe('unknown');
    expect(result.current.lastSeen).toBeNull();
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.version).toBeNull();
  });
});
