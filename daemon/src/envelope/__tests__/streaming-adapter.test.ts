// Streaming envelope adapter tests (Task #92).
//
// Coverage matrix (per task brief):
//   - happy path: Init → Data* → End
//   - client cancel: Init → Cancel → handler unsubscribed
//   - backpressure: slow client gets dropped past 1 MiB
//   - reconnect within budget: fromSeq replays gap-free
//   - reconnect outside budget: snapshot+gap=true
//   - fan-out to N subscribers from one fan-out registry

import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';

import {
  StreamHandlerRegistry,
  computeReplayDecision,
  mountStreamingAdapter,
  type StreamHandle,
  type StreamingHandler,
} from '../streaming-adapter.js';
import { decodeFrame, encodeFrame } from '../envelope.js';
import { createDataDispatcher } from '../../dispatcher.js';
import { createFanoutRegistry } from '../../pty/fanout-registry.js';

// ---------------------------------------------------------------------------
// Fake socket harness
// ---------------------------------------------------------------------------

function makeFakeSocket() {
  const sock = new PassThrough() as PassThrough & { destroyedByAdapter: boolean };
  sock.destroyedByAdapter = false;
  const outbound: Buffer[] = [];
  sock.write = ((chunk: unknown) => {
    outbound.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }) as typeof sock.write;
  const origDestroy = sock.destroy.bind(sock);
  sock.destroy = ((err?: Error) => {
    sock.destroyedByAdapter = true;
    return origDestroy(err);
  }) as typeof sock.destroy;
  return {
    socket: sock,
    feed: (b: Buffer) => sock.emit('data', b),
    outbound,
    destroyed: () => sock.destroyedByAdapter,
  };
}

function buildOpenFrame(args: {
  id: number;
  method: string;
  streamId: number;
  traceId?: string;
  body?: Record<string, unknown>;
}): Buffer {
  const headerObj: Record<string, unknown> = {
    id: args.id,
    method: args.method,
    stream: { streamId: args.streamId, seq: 0, kind: 'open' },
    payloadType: args.body !== undefined ? 'binary' : 'json',
    payloadLen: 0,
    ...(args.traceId !== undefined ? { traceId: args.traceId } : {}),
  };
  const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const payload =
    args.body !== undefined ? Buffer.from(JSON.stringify(args.body), 'utf8') : Buffer.alloc(0);
  return encodeFrame({ headerJson, payload });
}

function buildCancelFrame(args: { id: number; method: string; streamId: number }): Buffer {
  const headerObj = {
    id: args.id,
    method: args.method,
    stream: { streamId: args.streamId, kind: 'cancel' },
    payloadType: 'json' as const,
    payloadLen: 0,
  };
  const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
  return encodeFrame({ headerJson });
}

function decodeAll(outbound: Buffer[]): {
  header: Record<string, unknown>;
  payload: Buffer;
}[] {
  const frames: { header: Record<string, unknown>; payload: Buffer }[] = [];
  for (const buf of outbound) {
    let off = 0;
    while (off < buf.length) {
      const remainder = buf.subarray(off);
      const decoded = decodeFrame(remainder);
      const consumed = 4 + 2 + decoded.headerJson.length + decoded.payload.length;
      frames.push({
        header: JSON.parse(decoded.headerJson.toString('utf8')) as Record<string, unknown>,
        payload: decoded.payload,
      });
      off += consumed;
    }
  }
  return frames;
}

function makeContext(handler: StreamingHandler, method = 'ccsm.v1/test.subscribe') {
  const dispatcher = createDataDispatcher();
  // Register a stub unary handler so dispatchStreamingInit sees a registered
  // method (the stub is never invoked on the streaming path).
  dispatcher.register(method, async () => ({ streaming: true }));
  const handlers = new StreamHandlerRegistry();
  handlers.register(method, handler);
  return { dispatcher, handlers, method };
}

const silentLogger = { warn: vi.fn(), debug: vi.fn() };

// ---------------------------------------------------------------------------
// 1. Happy path: Init → Data* → End
// ---------------------------------------------------------------------------

describe('streaming adapter — happy path', () => {
  it('routes Init, emits Data frames with monotonic seq, then End', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    let openedHandle: StreamHandle | undefined;
    const handler: StreamingHandler = (_req, stream) => {
      openedHandle = stream;
      return () => {};
    };
    const ctx = makeContext(handler);

    mountStreamingAdapter({
      socket,
      dispatcher: ctx.dispatcher,
      handlers: ctx.handlers,
      bootNonce: 'BOOT-A',
      logger: silentLogger,
    });

    feed(
      buildOpenFrame({
        id: 7,
        method: ctx.method,
        streamId: 1,
        traceId: '01HZZZTESTULIDXXXXXXXXXXXX',
      }),
    );
    await new Promise((r) => setImmediate(r));

    expect(openedHandle).toBeDefined();

    // Emit two data frames + end.
    openedHandle!.data(Buffer.from('alpha', 'utf8'));
    openedHandle!.data(Buffer.from('beta', 'utf8'));
    openedHandle!.end({ code: 'OK' });

    const frames = decodeAll(outbound);
    // First frame is the streaming-init ack (`ack_source: 'dispatcher'`).
    expect(frames[0]!.header.ok).toBe(true);
    expect(frames[0]!.header.ack_source).toBe('dispatcher');

    // The next 3 frames are stream-frames.
    const streamFrames = frames.slice(1);
    expect(streamFrames).toHaveLength(3);

    expect((streamFrames[0]!.header.stream as Record<string, unknown>).kind).toBe('chunk');
    expect((streamFrames[0]!.header.stream as Record<string, unknown>).seq).toBe(0);
    expect(streamFrames[0]!.payload.toString('utf8')).toBe('alpha');
    expect(streamFrames[0]!.header.bootNonce).toBe('BOOT-A');

    expect((streamFrames[1]!.header.stream as Record<string, unknown>).seq).toBe(1);
    expect(streamFrames[1]!.payload.toString('utf8')).toBe('beta');

    expect((streamFrames[2]!.header.stream as Record<string, unknown>).kind).toBe('close');
    expect((streamFrames[2]!.header.stream as Record<string, unknown>).seq).toBe(2);
    expect(streamFrames[2]!.header.traceId).toBe('01HZZZTESTULIDXXXXXXXXXXXX');
  });

  it('splits payloads >16 KiB into ≤16 KiB sub-chunks each with its own seq', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    let openedHandle: StreamHandle | undefined;
    const handler: StreamingHandler = (_req, stream) => {
      openedHandle = stream;
      return () => {};
    };
    const ctx = makeContext(handler);
    mountStreamingAdapter({
      socket,
      dispatcher: ctx.dispatcher,
      handlers: ctx.handlers,
      bootNonce: 'BOOT-A',
      logger: silentLogger,
    });

    feed(buildOpenFrame({ id: 1, method: ctx.method, streamId: 1 }));
    await new Promise((r) => setImmediate(r));

    // 40 KiB -> three sub-chunks (16 + 16 + 8 KiB).
    const big = Buffer.alloc(40 * 1024, 0x42);
    openedHandle!.data(big);

    const frames = decodeAll(outbound).slice(1); // drop ack
    expect(frames).toHaveLength(3);
    expect(frames.reduce((sum, f) => sum + f.payload.length, 0)).toBe(40 * 1024);
    expect(frames.map((f) => (f.header.stream as Record<string, unknown>).seq)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 2. Client cancel
// ---------------------------------------------------------------------------

describe('streaming adapter — client cancel', () => {
  it('invokes the handler cancel hook and emits a CANCELLED close frame', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    const cancelSpy = vi.fn();
    const handler: StreamingHandler = () => cancelSpy;
    const ctx = makeContext(handler);

    const adapter = mountStreamingAdapter({
      socket,
      dispatcher: ctx.dispatcher,
      handlers: ctx.handlers,
      bootNonce: 'BOOT-A',
      logger: silentLogger,
    });

    feed(buildOpenFrame({ id: 9, method: ctx.method, streamId: 5 }));
    await new Promise((r) => setImmediate(r));
    expect(adapter.liveStreamCount()).toBe(1);

    feed(buildCancelFrame({ id: 0, method: ctx.method, streamId: 5 }));
    await new Promise((r) => setImmediate(r));

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(adapter.liveStreamCount()).toBe(0);

    const frames = decodeAll(outbound);
    const closeFrame = frames.find(
      (f) =>
        typeof f.header.stream === 'object' &&
        f.header.stream !== null &&
        (f.header.stream as Record<string, unknown>).kind === 'close',
    );
    expect(closeFrame).toBeDefined();
    expect(((closeFrame!.header as Record<string, unknown>).reason as Record<string, unknown>).code).toBe(
      'CANCELLED',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Backpressure: slow client dropped past 1 MiB
// ---------------------------------------------------------------------------

describe('streaming adapter — drop-slowest', () => {
  it('drops the subscriber with RESOURCE_EXHAUSTED past the 1 MiB watermark', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    let opened: StreamHandle | undefined;
    const handler: StreamingHandler = (_req, stream) => {
      opened = stream;
      return () => {};
    };
    const ctx = makeContext(handler);
    mountStreamingAdapter({
      socket,
      dispatcher: ctx.dispatcher,
      handlers: ctx.handlers,
      bootNonce: 'BOOT-A',
      // Use 64 KiB watermark so the test stays fast while exercising the
      // same code path that fires at the 1 MiB default.
      dropSlowestThresholdBytes: 64 * 1024,
      logger: silentLogger,
    });

    feed(buildOpenFrame({ id: 1, method: ctx.method, streamId: 1 }));
    await new Promise((r) => setImmediate(r));

    // Five 16 KiB writes = 80 KiB pending → exceeds 64 KiB threshold.
    for (let i = 0; i < 5; i += 1) {
      opened!.data(Buffer.alloc(16 * 1024, i));
    }

    const frames = decodeAll(outbound).slice(1); // drop ack
    const closeFrame = frames.find(
      (f) => (f.header.stream as Record<string, unknown>).kind === 'close',
    );
    expect(closeFrame).toBeDefined();
    expect((closeFrame!.header.reason as Record<string, unknown>).code).toBe('RESOURCE_EXHAUSTED');

    // Subsequent data() is a no-op (handler keeps writing but nothing more
    // appears on the wire).
    const beforeCount = outbound.length;
    opened!.data(Buffer.alloc(1024));
    expect(outbound.length).toBe(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Reconnect — within / outside replay budget
// ---------------------------------------------------------------------------

describe('computeReplayDecision', () => {
  it('emits replay-from when fromSeq sits inside the retained window', () => {
    const decision = computeReplayDecision({
      fromSeq: 5,
      oldestRetainedSeq: 3,
      newestRetainedSeq: 10,
    });
    expect(decision).toEqual({ mode: 'replay-from', seq: 5, gap: false });
  });

  it('emits snapshot+gap when fromSeq is older than the oldest retained chunk', () => {
    const decision = computeReplayDecision({
      fromSeq: 1,
      oldestRetainedSeq: 100,
      newestRetainedSeq: 250,
    });
    expect(decision).toEqual({ mode: 'snapshot', gap: true });
  });

  it('emits snapshot when fromSeq is absent', () => {
    const decision = computeReplayDecision({
      fromSeq: undefined,
      oldestRetainedSeq: 0,
      newestRetainedSeq: 5,
    });
    expect(decision).toEqual({ mode: 'snapshot', gap: false });
  });

  it('emits no-op when fromSeq is ahead of newest', () => {
    const decision = computeReplayDecision({
      fromSeq: 50,
      oldestRetainedSeq: 0,
      newestRetainedSeq: 5,
    });
    expect(decision).toEqual({ mode: 'no-op', gap: false });
  });
});

// ---------------------------------------------------------------------------
// 6. Boot-nonce mismatch on reconnect
// ---------------------------------------------------------------------------

describe('streaming adapter — bootChanged on nonce mismatch', () => {
  it('emits a bootChanged chunk before invoking the handler when fromBootNonce differs', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    const handler: StreamingHandler = (_req, stream) => {
      stream.end({ code: 'OK' });
      return () => {};
    };
    const ctx = makeContext(handler);
    mountStreamingAdapter({
      socket,
      dispatcher: ctx.dispatcher,
      handlers: ctx.handlers,
      bootNonce: 'BOOT-B',
      logger: silentLogger,
    });

    feed(
      buildOpenFrame({
        id: 1,
        method: ctx.method,
        streamId: 1,
        body: { fromSeq: 100, fromBootNonce: 'BOOT-A' },
      }),
    );
    await new Promise((r) => setImmediate(r));

    const frames = decodeAll(outbound).slice(1); // drop ack
    // First stream frame is the bootChanged chunk; second is the close.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0]!.header.bootChanged).toBe(true);
    expect(frames[0]!.header.snapshotPending).toBe(true);
    const meta = JSON.parse(frames[0]!.payload.toString('utf8'));
    expect(meta.kind).toBe('bootChanged');
    expect(meta.bootNonce).toBe('BOOT-B');
  });
});

// ---------------------------------------------------------------------------
// 7. Fan-out to N subscribers
// ---------------------------------------------------------------------------

describe('streaming adapter — fan-out registry hookup', () => {
  it('delivers each broadcast to N concurrent subscribers in registration order', async () => {
    // Each "subscriber" is a separate connection (new socket, new adapter).
    // The fan-out registry is shared across all of them.
    type Frame = { kind: 'delta'; seq: number; data: Uint8Array };
    const registry = createFanoutRegistry<Frame>();
    const sessionId = 'pty-test';

    const subscribers: { adapter: ReturnType<typeof mountStreamingAdapter>; outbound: Buffer[] }[] = [];

    const handler: StreamingHandler = (_req, stream) => {
      const sub = {
        deliver(message: Frame) {
          stream.data(Buffer.from(message.data));
        },
        close() {
          stream.end({ code: 'OK' });
        },
      };
      const unsub = registry.subscribe(sessionId, sub);
      return () => {
        unsub();
        stream.end({ code: 'CANCELLED' });
      };
    };

    const N = 4;
    for (let i = 0; i < N; i += 1) {
      const { socket, feed, outbound } = makeFakeSocket();
      const ctx = makeContext(handler);
      const adapter = mountStreamingAdapter({
        socket,
        dispatcher: ctx.dispatcher,
        handlers: ctx.handlers,
        bootNonce: 'BOOT-A',
        logger: silentLogger,
      });
      feed(buildOpenFrame({ id: 1, method: ctx.method, streamId: 1 }));
      await new Promise((r) => setImmediate(r));
      subscribers.push({ adapter, outbound });
    }

    // Broadcast 3 deltas through the shared registry.
    const messages: Frame[] = [
      { kind: 'delta', seq: 0, data: new Uint8Array([1, 2, 3]) },
      { kind: 'delta', seq: 1, data: new Uint8Array([4, 5, 6]) },
      { kind: 'delta', seq: 2, data: new Uint8Array([7, 8, 9]) },
    ];
    for (const m of messages) registry.broadcast(sessionId, m);

    // Every subscriber received all three deltas in order.
    for (const sub of subscribers) {
      const frames = decodeAll(sub.outbound)
        .slice(1) // drop the streaming-init ack
        .filter((f) => (f.header.stream as Record<string, unknown>).kind === 'chunk');
      expect(frames).toHaveLength(3);
      expect([...frames[0]!.payload]).toEqual([1, 2, 3]);
      expect([...frames[1]!.payload]).toEqual([4, 5, 6]);
      expect([...frames[2]!.payload]).toEqual([7, 8, 9]);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Plane / allowlist guard
// ---------------------------------------------------------------------------

describe('streaming adapter — Init validation', () => {
  it('rejects Init for unknown methods with UNKNOWN_METHOD on the dispatcher ack', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    const dispatcher = createDataDispatcher();
    const handlers = new StreamHandlerRegistry();
    mountStreamingAdapter({
      socket,
      dispatcher,
      handlers,
      bootNonce: 'BOOT-A',
      logger: silentLogger,
    });

    feed(buildOpenFrame({ id: 7, method: 'ccsm.v1/missing', streamId: 1 }));
    await new Promise((r) => setImmediate(r));

    const frames = decodeAll(outbound);
    expect(frames[0]!.header.ok).toBe(false);
    expect((frames[0]!.header.error as Record<string, unknown>).code).toBe('UNKNOWN_METHOD');
  });

  it('rejects duplicate streamId with INVALID_ARGUMENT', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    const handler: StreamingHandler = () => () => {};
    const ctx = makeContext(handler);
    mountStreamingAdapter({
      socket,
      dispatcher: ctx.dispatcher,
      handlers: ctx.handlers,
      bootNonce: 'BOOT-A',
      logger: silentLogger,
    });

    feed(buildOpenFrame({ id: 1, method: ctx.method, streamId: 1 }));
    await new Promise((r) => setImmediate(r));
    feed(buildOpenFrame({ id: 2, method: ctx.method, streamId: 1 }));
    await new Promise((r) => setImmediate(r));

    const frames = decodeAll(outbound);
    const errorAck = frames.find(
      (f) =>
        f.header.id === 2 &&
        f.header.ok === false &&
        (f.header.error as Record<string, unknown>).code === 'INVALID_ARGUMENT',
    );
    expect(errorAck).toBeDefined();
  });
});
