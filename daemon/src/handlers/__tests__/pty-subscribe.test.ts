// Unit tests for the `ccsm.v1/pty.subscribe` streaming RPC handler.
//
// Scope (Task #1057):
//   - subscribe path: 3 broadcast frames flow through to the stream's `push`.
//   - cancel path: returned cancel hook unsubscribes + emits `caller-cancel`
//     end frame exactly once.
//   - registry drain path: registry `close()` is mapped to the right
//     end-reason and propagated through `stream.end`.
//   - validation: bogus payload / unknown ptyId both produce a typed end
//     reason without subscribing to the registry.
//   - dispatcher wiring: refuses supervisor-plane registration; registers
//     under PTY_SUBSCRIBE_METHOD on the data-plane dispatcher.

import { describe, it, expect, vi } from 'vitest';

import {
  PTY_SUBSCRIBE_METHOD,
  handlePtySubscribe,
  registerPtySubscribeHandler,
  type PtySubscribeContext,
  type PtySubscribeFrame,
  type PtySubscribeStream,
  type PtySubscribeEndReason,
} from '../pty-subscribe.js';
import {
  createFanoutRegistry,
  type DrainReason,
  type FanoutRegistry,
} from '../../pty/fanout-registry.js';
import {
  createDataDispatcher,
  createSupervisorDispatcher,
} from '../../dispatcher.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CapturedStream extends PtySubscribeStream {
  pushed: PtySubscribeFrame[];
  ended: PtySubscribeEndReason[];
}

function makeStream(): CapturedStream {
  const pushed: PtySubscribeFrame[] = [];
  const ended: PtySubscribeEndReason[] = [];
  return {
    pushed,
    ended,
    push(frame) {
      pushed.push(frame);
    },
    end(reason) {
      ended.push(reason);
    },
  };
}

function makeCtx(
  overrides: Partial<PtySubscribeContext> = {},
): PtySubscribeContext & { registry: FanoutRegistry<PtySubscribeFrame> } {
  const registry =
    overrides.registry ?? createFanoutRegistry<PtySubscribeFrame>();
  return {
    registry,
    isValidPtyId: overrides.isValidPtyId ?? ((id) => id === 'pty-test'),
    log: overrides.log,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handlePtySubscribe — happy path streaming', () => {
  it('forwards three broadcast frames to the stream in order', () => {
    const ctx = makeCtx();
    const stream = makeStream();

    const cancel = handlePtySubscribe({ ptyId: 'pty-test' }, stream, ctx);

    const frames: PtySubscribeFrame[] = [
      { kind: 'delta', seq: 1, data: new Uint8Array([0x61]) },
      { kind: 'delta', seq: 2, data: new Uint8Array([0x62]) },
      { kind: 'delta', seq: 3, data: new Uint8Array([0x63]) },
    ];
    for (const f of frames) ctx.registry.broadcast('pty-test', f);

    expect(stream.pushed).toEqual(frames);
    expect(stream.ended).toEqual([]);
    expect(typeof cancel).toBe('function');

    cancel();
  });

  it('does not deliver frames broadcast to a different sessionId', () => {
    const ctx = makeCtx({
      isValidPtyId: (id) => id === 'pty-test' || id === 'pty-other',
    });
    const stream = makeStream();
    handlePtySubscribe({ ptyId: 'pty-test' }, stream, ctx);

    ctx.registry.broadcast('pty-other', {
      kind: 'delta',
      seq: 99,
      data: new Uint8Array([0xff]),
    });

    expect(stream.pushed).toEqual([]);
  });
});

describe('handlePtySubscribe — cancel path', () => {
  it('unsubscribes from the registry and emits caller-cancel exactly once', () => {
    const ctx = makeCtx();
    const stream = makeStream();
    const cancel = handlePtySubscribe({ ptyId: 'pty-test' }, stream, ctx);

    expect(ctx.registry.getSubscribers('pty-test')).toHaveLength(1);

    cancel();

    expect(ctx.registry.getSubscribers('pty-test')).toHaveLength(0);
    expect(stream.ended).toEqual([{ kind: 'caller-cancel' }]);

    // Post-cancel broadcasts must not reach the stream.
    ctx.registry.broadcast('pty-test', {
      kind: 'delta',
      seq: 4,
      data: new Uint8Array([0x64]),
    });
    expect(stream.pushed).toEqual([]);

    // Idempotent: second cancel is a no-op (no extra end frame).
    cancel();
    expect(stream.ended).toEqual([{ kind: 'caller-cancel' }]);
  });
});

describe('handlePtySubscribe — registry drain path', () => {
  it.each<{
    drain: DrainReason;
    expected: PtySubscribeEndReason;
  }>([
    {
      drain: { kind: 'pty-exit', detail: 'exit code 0' },
      expected: { kind: 'pty-exit', detail: 'exit code 0' },
    },
    {
      drain: { kind: 'pty-crashed' },
      expected: { kind: 'pty-crashed' },
    },
    {
      drain: { kind: 'daemon-shutdown', detail: 'sigterm' },
      expected: { kind: 'daemon-shutdown', detail: 'sigterm' },
    },
    {
      drain: { kind: 'session-removed' },
      expected: { kind: 'session-removed' },
    },
  ])('maps drain reason $drain.kind to matching end-reason', ({ drain, expected }) => {
    const ctx = makeCtx();
    const stream = makeStream();
    const cancel = handlePtySubscribe({ ptyId: 'pty-test' }, stream, ctx);

    ctx.registry.drainSession('pty-test', drain);

    expect(stream.ended).toEqual([expected]);
    // Cancel after drain is a no-op (idempotent end).
    cancel();
    expect(stream.ended).toEqual([expected]);
  });
});

describe('handlePtySubscribe — validation gates', () => {
  it('rejects non-object payload with invalid-request and never subscribes', () => {
    const ctx = makeCtx();
    const stream = makeStream();
    const subscribeSpy = vi.spyOn(ctx.registry, 'subscribe');

    const cancel = handlePtySubscribe(null, stream, ctx);

    expect(stream.ended).toHaveLength(1);
    expect(stream.ended[0]?.kind).toBe('invalid-request');
    expect(subscribeSpy).not.toHaveBeenCalled();
    cancel(); // safe no-op
  });

  it('rejects missing ptyId with invalid-request', () => {
    const ctx = makeCtx();
    const stream = makeStream();
    handlePtySubscribe({}, stream, ctx);
    expect(stream.ended[0]?.kind).toBe('invalid-request');
  });

  it('rejects unknown ptyId with invalid-pty-id and never subscribes', () => {
    const ctx = makeCtx();
    const stream = makeStream();
    const subscribeSpy = vi.spyOn(ctx.registry, 'subscribe');

    handlePtySubscribe({ ptyId: 'pty-bogus' }, stream, ctx);

    expect(stream.ended).toEqual([{ kind: 'invalid-pty-id', ptyId: 'pty-bogus' }]);
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});

describe('registerPtySubscribeHandler — dispatcher wiring', () => {
  it('registers PTY_SUBSCRIBE_METHOD on a data-plane dispatcher', () => {
    const dispatcher = createDataDispatcher();
    const ctx = makeCtx();

    const { method, handle } = registerPtySubscribeHandler(dispatcher, ctx);

    expect(method).toBe(PTY_SUBSCRIBE_METHOD);
    expect(method).toBe('ccsm.v1/pty.subscribe');
    expect(dispatcher.has(PTY_SUBSCRIBE_METHOD)).toBe(true);
    expect(typeof handle).toBe('function');

    // The streaming entry point still works after registration.
    const stream = makeStream();
    const cancel = handle({ ptyId: 'pty-test' }, stream);
    ctx.registry.broadcast('pty-test', {
      kind: 'heartbeat',
      ts: 1234,
    });
    expect(stream.pushed).toEqual([{ kind: 'heartbeat', ts: 1234 }]);
    cancel();
    expect(stream.ended).toEqual([{ kind: 'caller-cancel' }]);
  });

  it('refuses to register on a supervisor-plane dispatcher', () => {
    const dispatcher = createSupervisorDispatcher();
    const ctx = makeCtx();

    expect(() => registerPtySubscribeHandler(dispatcher, ctx)).toThrow(
      /supervisor-plane/i,
    );
  });
});
