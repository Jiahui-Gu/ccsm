// Unit tests for the in-memory SessionEventBus (T3.2).
//
// Covers the security-critical guarantees:
//   - principal-scoped fanout: subscribers ONLY see events whose
//     `session.owner_id` matches their `principalKey`.
//   - listener exception isolation: a throwing listener does not break
//     fanout to its peers.
//   - unsubscribe is idempotent and removes the listener.
//   - listenerCount reflects subscribe/unsubscribe correctly.
//
// Spec refs: ch05 §5 (WatchSessions principal-scoped enforcement).

import { describe, expect, it, vi } from 'vitest';

import { SessionEventBus } from '../../src/sessions/event-bus.js';
import { SessionState, type SessionEvent, type SessionRow } from '../../src/sessions/types.js';

function makeRow(owner: string, id = 'row-1'): SessionRow {
  return {
    id,
    owner_id: owner,
    state: SessionState.STARTING,
    cwd: '/tmp',
    env_json: '{}',
    claude_args_json: '[]',
    geometry_cols: 80,
    geometry_rows: 24,
    exit_code: -1,
    created_ms: 1,
    last_active_ms: 1,
    should_be_running: 1,
  };
}

function created(row: SessionRow): SessionEvent {
  return { kind: 'created', session: row };
}

describe('SessionEventBus', () => {
  it('delivers events only to subscribers whose principalKey matches event.session.owner_id', () => {
    const bus = new SessionEventBus();
    const aliceListener = vi.fn();
    const bobListener = vi.fn();
    bus.subscribe('local-user:alice', aliceListener);
    bus.subscribe('local-user:bob', bobListener);

    bus.publish(created(makeRow('local-user:alice', 'sess-a')));
    bus.publish(created(makeRow('local-user:bob', 'sess-b')));

    expect(aliceListener).toHaveBeenCalledTimes(1);
    expect(aliceListener.mock.calls[0]?.[0].session.id).toBe('sess-a');
    expect(bobListener).toHaveBeenCalledTimes(1);
    expect(bobListener.mock.calls[0]?.[0].session.id).toBe('sess-b');
  });

  it('does not leak cross-principal events even when many subscribers share the bus', () => {
    const bus = new SessionEventBus();
    const owners = ['p:1', 'p:2', 'p:3', 'p:4'];
    const listeners = new Map(owners.map((o) => [o, vi.fn()] as const));
    for (const [owner, listener] of listeners) bus.subscribe(owner, listener);

    bus.publish(created(makeRow('p:2', 'only-p2')));

    for (const [owner, listener] of listeners) {
      if (owner === 'p:2') expect(listener).toHaveBeenCalledTimes(1);
      else expect(listener).not.toHaveBeenCalled();
    }
  });

  it('unsubscribe removes the listener and is idempotent', () => {
    const bus = new SessionEventBus();
    const listener = vi.fn();
    const unsub = bus.subscribe('local-user:alice', listener);

    expect(bus.listenerCount('local-user:alice')).toBe(1);
    unsub();
    expect(bus.listenerCount('local-user:alice')).toBe(0);
    // second call must be a no-op
    expect(() => unsub()).not.toThrow();
    expect(bus.listenerCount('local-user:alice')).toBe(0);

    bus.publish(created(makeRow('local-user:alice')));
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates listener exceptions: one throwing listener does not block its peers', () => {
    const errors: unknown[] = [];
    const bus = new SessionEventBus({
      onListenerError: (err) => errors.push(err),
    });
    const thrower = vi.fn(() => {
      throw new Error('boom');
    });
    const survivor = vi.fn();
    bus.subscribe('local-user:alice', thrower);
    bus.subscribe('local-user:alice', survivor);

    bus.publish(created(makeRow('local-user:alice')));

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('snapshot iteration: a listener that unsubscribes during dispatch does not skip its peers', () => {
    const bus = new SessionEventBus();
    const calls: string[] = [];

    let unsubA: () => void = () => {};
    const a = vi.fn(() => {
      calls.push('a');
      unsubA();
    });
    const b = vi.fn(() => calls.push('b'));
    unsubA = bus.subscribe('local-user:alice', a);
    bus.subscribe('local-user:alice', b);

    bus.publish(created(makeRow('local-user:alice')));

    expect(calls).toEqual(['a', 'b']);
    expect(bus.listenerCount('local-user:alice')).toBe(1);
  });

  it('publish with no subscribers is a no-op', () => {
    const bus = new SessionEventBus();
    expect(() => bus.publish(created(makeRow('nobody-listening')))).not.toThrow();
  });

  it('rejects empty / non-string principalKey on subscribe', () => {
    const bus = new SessionEventBus();
    expect(() => bus.subscribe('', vi.fn())).toThrow(TypeError);
    // @ts-expect-error — runtime validation guard
    expect(() => bus.subscribe(undefined, vi.fn())).toThrow(TypeError);
  });
});
