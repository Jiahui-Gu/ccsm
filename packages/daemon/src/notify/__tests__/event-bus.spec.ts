// Unit tests for the in-memory NotifyEventBus.
//
// Mirrors the SessionEventBus spec (`test/sessions/event-bus.spec.ts`) but
// without the principal-key dimension — see `event-bus.ts` design notes
// for why notify scoping lives at the handler layer.
//
// Covers:
//   - fanout: every subscriber sees every event.
//   - listener exception isolation: a throwing listener does not break
//     fanout to its peers.
//   - unsubscribe is idempotent and removes the listener.
//   - listenerCount reflects subscribe/unsubscribe correctly.
//   - snapshot iteration: a listener that unsubscribes during dispatch
//     does not skip its peers.
//   - default onListenerError funnels through console.error rather than
//     swallowing exceptions silently (regression guard against making the
//     bus look healthy while subscribers are quietly broken).
//   - integration with `runStateTracker`: each non-null decision emits
//     exactly one NotifyEvent; null decisions emit none. This is the
//     wire-up evidence for audit #228 sub-task 8.

import { describe, expect, it, vi } from 'vitest';

import { NotifyEventBus, type NotifyEvent } from '../event-bus.js';
import { decide } from '../notifyDecider.js';
import { createRunStateTracker } from '../runStateTracker.js';

const NOW = 1_700_000_000_000;

function evt(sid = 's1', overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return { sid, toast: true, flash: true, ts: NOW, ...overrides };
}

describe('NotifyEventBus', () => {
  it('fans out every event to every subscriber', () => {
    const bus = new NotifyEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.onNotifyEvent(a);
    bus.onNotifyEvent(b);

    bus.emitNotifyEvent(evt('s1'));
    bus.emitNotifyEvent(evt('s2', { toast: false }));

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    expect(a.mock.calls[0]?.[0].sid).toBe('s1');
    expect(a.mock.calls[1]?.[0].sid).toBe('s2');
    expect(a.mock.calls[1]?.[0].toast).toBe(false);
  });

  it('unsubscribe removes the listener and is idempotent', () => {
    const bus = new NotifyEventBus();
    const listener = vi.fn();
    const unsub = bus.onNotifyEvent(listener);

    expect(bus.listenerCount()).toBe(1);
    unsub();
    expect(bus.listenerCount()).toBe(0);
    // second call must be a no-op
    expect(() => unsub()).not.toThrow();
    expect(bus.listenerCount()).toBe(0);

    bus.emitNotifyEvent(evt());
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates listener exceptions: one throwing listener does not block its peers', () => {
    const errors: unknown[] = [];
    const bus = new NotifyEventBus({
      onListenerError: (err) => errors.push(err),
    });
    const thrower = vi.fn(() => {
      throw new Error('boom');
    });
    const survivor = vi.fn();
    bus.onNotifyEvent(thrower);
    bus.onNotifyEvent(survivor);

    bus.emitNotifyEvent(evt());

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('snapshot iteration: a listener that unsubscribes during dispatch does not skip its peers', () => {
    const bus = new NotifyEventBus();
    const calls: string[] = [];

    let unsubA: () => void = () => {};
    const a = vi.fn(() => {
      calls.push('a');
      unsubA();
    });
    const b = vi.fn(() => calls.push('b'));
    unsubA = bus.onNotifyEvent(a);
    bus.onNotifyEvent(b);

    bus.emitNotifyEvent(evt());

    expect(calls).toEqual(['a', 'b']);
    expect(bus.listenerCount()).toBe(1);
  });

  it('emit with no subscribers is a no-op', () => {
    const bus = new NotifyEventBus();
    expect(() => bus.emitNotifyEvent(evt('nobody-listening'))).not.toThrow();
  });

  it('default onListenerError surfaces exceptions through console.error', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Construct AFTER the spy: the bus binds `console.error` by
      // reference at construction time, so a later spy would not be
      // observed.
      const bus = new NotifyEventBus();
      const thrower = vi.fn(() => {
        throw new Error('default-handler-test');
      });
      bus.onNotifyEvent(thrower);

      bus.emitNotifyEvent(evt());

      expect(thrower).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0]?.[0]).toBe(
        '[ccsm-daemon] NotifyEventBus listener threw',
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('same listener registered twice fires twice (matches SessionEventBus semantics)', () => {
    const bus = new NotifyEventBus();
    const listener = vi.fn();
    const unsub1 = bus.onNotifyEvent(listener);
    const unsub2 = bus.onNotifyEvent(listener);

    // Set-based store — registering the same identity twice is a no-op.
    expect(bus.listenerCount()).toBe(1);

    bus.emitNotifyEvent(evt());
    expect(listener).toHaveBeenCalledTimes(1);

    unsub1();
    expect(bus.listenerCount()).toBe(0);
    // unsub2 still safe to call
    expect(() => unsub2()).not.toThrow();
  });
});

describe('runStateTracker → NotifyEventBus integration', () => {
  it('emits exactly one NotifyEvent per non-null decision, with the decision flags + timestamp', () => {
    const bus = new NotifyEventBus();
    const events: NotifyEvent[] = [];
    bus.onNotifyEvent((e) => events.push(e));

    const tracker = createRunStateTracker(decide, bus);
    tracker.setFocused(false); // Rule 5 → toast + flash

    expect(tracker.onTitle('s1', 'running', NOW)).toBeNull();
    expect(events).toHaveLength(0); // running titles don't fire

    const dec = tracker.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      sid: 's1',
      toast: true,
      flash: true,
      ts: NOW + 1_000,
    });
  });

  it('does not emit when the decision is null (dedupe / boot-banner gate / no rule match)', () => {
    const bus = new NotifyEventBus();
    const listener = vi.fn();
    bus.onNotifyEvent(listener);

    const tracker = createRunStateTracker(decide, bus);

    // hasObservedRunning gate (Task #767): idle without a prior 'running' is suppressed.
    expect(tracker.onTitle('s1', 'idle', NOW)).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    // 'unknown' classification is a no-op.
    expect(tracker.onTitle('s1', 'unknown', NOW + 100)).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('omitting the bus argument leaves runStateTracker behaviour unchanged (additive wiring)', () => {
    // Regression guard for the optional eventBus parameter: existing
    // call sites that pass only `decide` must keep working.
    const tracker = createRunStateTracker(decide);
    tracker.setFocused(false);
    tracker.onTitle('s1', 'running', NOW);
    const dec = tracker.onTitle('s1', 'idle', NOW + 1_000);
    expect(dec).not.toBeNull();
    expect(dec?.toast).toBe(true);
    expect(dec?.flash).toBe(true);
  });
});
