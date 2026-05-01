import { describe, it, expect, vi } from 'vitest';
import {
  createFanoutRegistry,
  type DrainReason,
  type Subscriber,
} from '../fanout-registry.js';

type Msg = string;

function makeSubscriber(): Subscriber<Msg> & {
  delivered: Msg[];
  closedWith: DrainReason[];
} {
  const delivered: Msg[] = [];
  const closedWith: DrainReason[] = [];
  return {
    delivered,
    closedWith,
    deliver(msg) {
      delivered.push(msg);
    },
    close(reason) {
      closedWith.push(reason);
    },
  };
}

describe('createFanoutRegistry', () => {
  it('subscribe + broadcast → all subscribers receive in registration order', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    const b = makeSubscriber();
    reg.subscribe('s1', a);
    reg.subscribe('s1', b);
    reg.broadcast('s1', 'hello');
    expect(a.delivered).toEqual(['hello']);
    expect(b.delivered).toEqual(['hello']);
  });

  it('subscribe + unsubscribe via returned fn → next broadcast skips that subscriber', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    const b = makeSubscriber();
    const offA = reg.subscribe('s1', a);
    reg.subscribe('s1', b);
    reg.broadcast('s1', 'first');
    offA();
    reg.broadcast('s1', 'second');
    expect(a.delivered).toEqual(['first']);
    expect(b.delivered).toEqual(['first', 'second']);
  });

  it('returned unsubscribe fn is idempotent', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    const off = reg.subscribe('s1', a);
    off();
    off(); // must not throw
    expect(reg.getSubscribers('s1')).toEqual([]);
  });

  it('explicit unsubscribe(sessionId, sub) works equivalently', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    reg.subscribe('s1', a);
    reg.unsubscribe('s1', a);
    reg.broadcast('s1', 'x');
    expect(a.delivered).toEqual([]);
  });

  it('explicit unsubscribe does NOT invoke close()', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    reg.subscribe('s1', a);
    reg.unsubscribe('s1', a);
    expect(a.closedWith).toEqual([]);
  });

  it('multiple sessions are isolated — broadcast to A does not reach B', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    const b = makeSubscriber();
    reg.subscribe('s1', a);
    reg.subscribe('s2', b);
    reg.broadcast('s1', 'for-a');
    expect(a.delivered).toEqual(['for-a']);
    expect(b.delivered).toEqual([]);
    reg.broadcast('s2', 'for-b');
    expect(a.delivered).toEqual(['for-a']);
    expect(b.delivered).toEqual(['for-b']);
  });

  it('drainSession invokes close on every subscriber with the given reason', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    const b = makeSubscriber();
    reg.subscribe('s1', a);
    reg.subscribe('s1', b);
    const reason: DrainReason = { kind: 'pty-exit', detail: 'code=0' };
    reg.drainSession('s1', reason);
    expect(a.closedWith).toEqual([reason]);
    expect(b.closedWith).toEqual([reason]);
  });

  it('drainSession empties the session — subsequent broadcast is a no-op', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    reg.subscribe('s1', a);
    reg.drainSession('s1', { kind: 'pty-exit' });
    reg.broadcast('s1', 'after-drain');
    expect(a.delivered).toEqual([]);
    expect(reg.getSubscribers('s1')).toEqual([]);
  });

  it('drainSession does NOT cross sessions', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    const b = makeSubscriber();
    reg.subscribe('s1', a);
    reg.subscribe('s2', b);
    reg.drainSession('s1', { kind: 'daemon-shutdown' });
    expect(a.closedWith.length).toBe(1);
    expect(b.closedWith).toEqual([]);
    reg.broadcast('s2', 'still-alive');
    expect(b.delivered).toEqual(['still-alive']);
  });

  it('subscribe-during-broadcast: snapshot iteration — newcomer does NOT receive current message', () => {
    const reg = createFanoutRegistry<Msg>();
    const newcomer = makeSubscriber();
    const inserter: Subscriber<Msg> = {
      deliver() {
        reg.subscribe('s1', newcomer);
      },
      close() {},
    };
    reg.subscribe('s1', inserter);
    reg.broadcast('s1', 'first');
    expect(newcomer.delivered).toEqual([]);
    reg.broadcast('s1', 'second');
    expect(newcomer.delivered).toEqual(['second']);
  });

  it('unsubscribe-during-broadcast: does not crash, peers still receive', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    const c = makeSubscriber();
    const selfRemoving: Subscriber<Msg> = {
      deliver() {
        reg.unsubscribe('s1', selfRemoving);
      },
      close() {},
    };
    reg.subscribe('s1', a);
    reg.subscribe('s1', selfRemoving);
    reg.subscribe('s1', c);
    expect(() => reg.broadcast('s1', 'msg')).not.toThrow();
    // a and c both delivered (snapshot was taken); selfRemoving is gone
    // for next broadcast.
    expect(a.delivered).toEqual(['msg']);
    expect(c.delivered).toEqual(['msg']);
    expect(reg.getSubscribers('s1')).toEqual([a, c]);
    reg.broadcast('s1', 'msg2');
    expect(a.delivered).toEqual(['msg', 'msg2']);
    expect(c.delivered).toEqual(['msg', 'msg2']);
  });

  it('broadcast to a session with no subscribers is a no-op (no throw)', () => {
    const reg = createFanoutRegistry<Msg>();
    expect(() => reg.broadcast('nonexistent', 'x')).not.toThrow();
  });

  it('drainSession on a session with no subscribers is a no-op (no throw)', () => {
    const reg = createFanoutRegistry<Msg>();
    expect(() =>
      reg.drainSession('nonexistent', { kind: 'pty-exit' }),
    ).not.toThrow();
  });

  it('subscriber that throws in deliver does not poison peers; error logged via onSubscriberError', () => {
    const onSubscriberError = vi.fn();
    const reg = createFanoutRegistry<Msg>({ onSubscriberError });
    const bad: Subscriber<Msg> = {
      deliver() {
        throw new Error('boom');
      },
      close() {},
    };
    const good = makeSubscriber();
    reg.subscribe('s1', bad);
    reg.subscribe('s1', good);
    reg.broadcast('s1', 'msg');
    expect(good.delivered).toEqual(['msg']);
    expect(onSubscriberError).toHaveBeenCalledTimes(1);
    const [err, ctx] = onSubscriberError.mock.calls[0]!;
    expect((err as Error).message).toBe('boom');
    expect(ctx).toEqual({ sessionId: 's1', phase: 'deliver' });
  });

  it('subscriber that throws in close does not block peers; error logged', () => {
    const onSubscriberError = vi.fn();
    const reg = createFanoutRegistry<Msg>({ onSubscriberError });
    const bad: Subscriber<Msg> = {
      deliver() {},
      close() {
        throw new Error('close-boom');
      },
    };
    const good = makeSubscriber();
    reg.subscribe('s1', bad);
    reg.subscribe('s1', good);
    reg.drainSession('s1', { kind: 'daemon-shutdown' });
    expect(good.closedWith.length).toBe(1);
    expect(onSubscriberError).toHaveBeenCalledTimes(1);
    expect(onSubscriberError.mock.calls[0]![1]).toEqual({
      sessionId: 's1',
      phase: 'close',
    });
  });

  it('getSubscribers returns a snapshot — mutating it does not affect registry', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    reg.subscribe('s1', a);
    const snap = reg.getSubscribers('s1') as Subscriber<Msg>[];
    snap.length = 0;
    expect(reg.getSubscribers('s1')).toEqual([a]);
  });

  it('same Subscriber object on two different sessions is independent', () => {
    const reg = createFanoutRegistry<Msg>();
    const shared = makeSubscriber();
    reg.subscribe('s1', shared);
    reg.subscribe('s2', shared);
    reg.broadcast('s1', 'a');
    reg.broadcast('s2', 'b');
    expect(shared.delivered).toEqual(['a', 'b']);
    reg.drainSession('s1', { kind: 'pty-exit' });
    // s2 still has it
    expect(reg.getSubscribers('s2')).toEqual([shared]);
    reg.broadcast('s2', 'c');
    expect(shared.delivered).toEqual(['a', 'b', 'c']);
  });

  it('double-subscribe of same subscriber to same session is deduped (Set semantics)', () => {
    const reg = createFanoutRegistry<Msg>();
    const a = makeSubscriber();
    reg.subscribe('s1', a);
    reg.subscribe('s1', a);
    reg.broadcast('s1', 'msg');
    expect(a.delivered).toEqual(['msg']); // delivered exactly once
    expect(reg.getSubscribers('s1')).toEqual([a]);
  });
});
