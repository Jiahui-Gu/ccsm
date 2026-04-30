import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../src/agent/lifecycle', () => {
  const unsubscribe = vi.fn();
  const subscribeAgentEvents = vi.fn(() => unsubscribe);
  return { subscribeAgentEvents, __unsubscribe: unsubscribe };
});

import { useAgentEventBridge } from '../../src/app-effects/useAgentEventBridge';
import * as lifecycle from '../../src/agent/lifecycle';

const subscribeAgentEvents = lifecycle.subscribeAgentEvents as unknown as ReturnType<
  typeof vi.fn
>;
const unsubscribe = (lifecycle as unknown as { __unsubscribe: ReturnType<typeof vi.fn> })
  .__unsubscribe;

describe('useAgentEventBridge', () => {
  it('subscribes on mount and unsubscribes on unmount', () => {
    subscribeAgentEvents.mockClear();
    unsubscribe.mockClear();
    const { unmount } = renderHook(() => useAgentEventBridge());
    expect(subscribeAgentEvents).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not re-subscribe across re-renders', () => {
    subscribeAgentEvents.mockClear();
    const { rerender } = renderHook(() => useAgentEventBridge());
    rerender();
    rerender();
    expect(subscribeAgentEvents).toHaveBeenCalledTimes(1);
  });
});
