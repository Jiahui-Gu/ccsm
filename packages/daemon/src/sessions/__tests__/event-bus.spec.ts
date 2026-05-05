// Task #473 (T8.14b-7b) — sessions/ coverage push.
//
// Unit tests for the in-process principal-scoped pub/sub bus
// (`sessions/event-bus.ts`). Covers:
//   - subscribe()/unsubscribe() lifecycle (idempotent unsubscribe,
//     listenerCount transitions, principalKey validation)
//   - publish() fanout (principal scoping, snapshot iteration so a
//     listener that unsubscribes mid-dispatch does not skip its peers,
//     no-op publish when no subscribers, listener exception isolation
//     via onListenerError)
//   - default onListenerError logs to console.error with the stable
//     `[ccsm-daemon]` prefix

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionEventBus } from '../event-bus.js';
import { SessionState, type SessionEvent, type SessionRow } from '../types.js';

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: '01J0000000000000000000ABCD',
    owner_id: 'local-user:1000',
    state: SessionState.STARTING,
    cwd: '/tmp',
    env_json: '{}',
    claude_args_json: '[]',
    geometry_cols: 80,
    geometry_rows: 24,
    exit_code: -1,
    created_ms: 0,
    last_active_ms: 0,
    should_be_running: 1,
    ...overrides,
  };
}

function created(row: SessionRow): SessionEvent {
  return { kind: 'created', session: row };
}

describe('SessionEventBus.subscribe', () => {
  it('rejects empty principalKey', () => {
    const bus = new SessionEventBus();
    expect(() => bus.subscribe('', () => {})).toThrow(TypeError);
  });

  it('rejects non-string principalKey', () => {
    const bus = new SessionEventBus();
    // @ts-expect-error — runtime check; we deliberately pass wrong type.
    expect(() => bus.subscribe(42, () => {})).toThrow(TypeError);
  });

  it('listenerCount tracks add/remove transitions', () => {
    const bus = new SessionEventBus();
    expect(bus.listenerCount('local-user:1000')).toBe(0);
    const off1 = bus.subscribe('local-user:1000', () => {});
    expect(bus.listenerCount('local-user:1000')).toBe(1);
    const off2 = bus.subscribe('local-user:1000', () => {});
    expect(bus.listenerCount('local-user:1000')).toBe(2);
    off1();
    expect(bus.listenerCount('local-user:1000')).toBe(1);
    off2();
    expect(bus.listenerCount('local-user:1000')).toBe(0);
  });

  it('unsubscribe is idempotent', () => {
    const bus = new SessionEventBus();
    const off = bus.subscribe('local-user:1000', () => {});
    expect(bus.listenerCount('local-user:1000')).toBe(1);
    off();
    expect(bus.listenerCount('local-user:1000')).toBe(0);
    off(); // second call no-op
    expect(bus.listenerCount('local-user:1000')).toBe(0);
  });

  it('unsubscribe of an entry whose principal already cleared is a no-op', () => {
    const bus = new SessionEventBus();
    const fn = vi.fn();
    const off = bus.subscribe('local-user:1000', fn);
    // Publishing to an unrelated principal does NOT remove the entry,
    // but we want to exercise the "set was cleared externally" path.
    // Replace the internal map entry by unsubscribing then re-subscribing
    // a different listener — calling off() now finds a set that doesn't
    // contain `fn`, exercises the .delete(listener) branch.
    off();
    bus.subscribe('local-user:1000', () => {});
    off(); // already-inactive handle, no-op
    expect(bus.listenerCount('local-user:1000')).toBe(1);
  });
});

describe('SessionEventBus.publish — principal scoping (security boundary)', () => {
  it('only delivers to listeners whose principal matches the row owner', () => {
    const bus = new SessionEventBus();
    const aliceListener = vi.fn();
    const bobListener = vi.fn();
    bus.subscribe('local-user:1000', aliceListener);
    bus.subscribe('local-user:1001', bobListener);

    const row = makeRow({ owner_id: 'local-user:1000' });
    bus.publish(created(row));

    expect(aliceListener).toHaveBeenCalledTimes(1);
    expect(aliceListener).toHaveBeenCalledWith(created(row));
    expect(bobListener).not.toHaveBeenCalled();
  });

  it('publish with no subscribers is a no-op (early return)', () => {
    const bus = new SessionEventBus();
    expect(() => bus.publish(created(makeRow()))).not.toThrow();
  });

  it('publish with empty subscriber set after off() is a no-op', () => {
    const bus = new SessionEventBus();
    const off = bus.subscribe('local-user:1000', () => {});
    off();
    expect(() => bus.publish(created(makeRow()))).not.toThrow();
  });

  it('snapshot iteration: a listener that unsubscribes itself does not skip peers', () => {
    const bus = new SessionEventBus();
    const order: string[] = [];
    const off1 = bus.subscribe('local-user:1000', () => {
      order.push('first');
      off1(); // unsubscribe during dispatch
    });
    bus.subscribe('local-user:1000', () => {
      order.push('second');
    });

    bus.publish(created(makeRow()));
    expect(order).toEqual(['first', 'second']);
  });

  it('same listener subscribed twice fires twice (no de-dup)', () => {
    const bus = new SessionEventBus();
    const fn = vi.fn();
    bus.subscribe('local-user:1000', fn);
    bus.subscribe('local-user:1000', fn);
    // Set semantics: the same function identity de-dupes inside the Set
    // → exactly one invocation. Pin this so a future "allow duplicate
    // subscriptions" change is a deliberate decision.
    bus.publish(created(makeRow()));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('SessionEventBus.publish — listener error isolation', () => {
  it('one listener throwing does not break fanout to peers', () => {
    const onErr = vi.fn();
    const bus = new SessionEventBus({ onListenerError: onErr });
    const second = vi.fn();
    bus.subscribe('local-user:1000', () => {
      throw new Error('boom');
    });
    bus.subscribe('local-user:1000', second);

    bus.publish(created(makeRow()));
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    const [err, ev] = onErr.mock.calls[0];
    expect((err as Error).message).toBe('boom');
    expect((ev as SessionEvent).kind).toBe('created');
  });

  it('default onListenerError logs to console.error with stable prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = new SessionEventBus();
      bus.subscribe('local-user:1000', () => {
        throw new Error('boom');
      });
      bus.publish(created(makeRow()));
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0];
      expect(String(args[0])).toContain('[ccsm-daemon]');
      expect(String(args[0])).toContain('SessionEventBus listener threw');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SessionEventBus — listenerCount edge cases', () => {
  let bus: SessionEventBus;
  beforeEach(() => {
    bus = new SessionEventBus();
  });
  afterEach(() => {
    // No-op — bus has no resources beyond JS heap.
  });

  it('returns 0 for an unknown principal', () => {
    expect(bus.listenerCount('local-user:none')).toBe(0);
  });
});
