// Daemon-side envelope adapter tests (Task #28 / B7a).
//
// Test cases cover the four spec-mandated scenarios from the task brief:
//   1. Framing happy path (well-formed frame -> dispatcher -> reply byte-equal
//      decodes back to `{ id, ok: true, value, ack_source }`).
//   2. Truncated read (one frame split across multiple `data` events;
//      dispatcher only fires once after the second chunk arrives).
//   3. Oversized message (header claiming > 16 MiB -> synthetic
//      `envelope_too_large` reply with `id: 0` + socket destroyed).
//   4. Malformed JSON header (valid framing, garbage header bytes -> synthetic
//      `schema_violation` reply + socket destroyed).
//
// Plus a small clutch of safety tests: schema-violation on missing routing
// fields; dispatcher rejections passed through; multiple frames in one chunk
// are all dispatched.
//
// Spec citations:
//   - frag-3.4.1 §3.4.1.a (oversize rejection sequence)
//   - frag-3.4.1 §3.4.1.c (header schema)
//   - frag-3.4.1 §3.4.1.d (schema_violation + destroy)

import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';

import { mountEnvelopeAdapter } from '../adapter.js';
import { decodeFrame, encodeFrame, ENVELOPE_LIMITS } from '../envelope.js';
import type { Dispatcher, DispatchResult } from '../../dispatcher.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * A minimal Duplex stand-in: writes from the adapter land in `outbound`,
 * `feed()` simulates inbound `data` events, and `destroy()` flips a flag.
 *
 * Using two `PassThrough`s would also work but a thin shim keeps assertions
 * direct (we look at `outbound[0]` rather than awaiting `data` events on a
 * second stream).
 */
function makeFakeSocket(): {
  socket: PassThrough & { destroyedByAdapter: boolean };
  feed: (b: Buffer) => void;
  outbound: Buffer[];
  destroyed: () => boolean;
} {
  const sock = new PassThrough() as PassThrough & { destroyedByAdapter: boolean };
  sock.destroyedByAdapter = false;
  const outbound: Buffer[] = [];
  // Capture writes by overriding write to push the chunks into outbound.
  // (PassThrough would otherwise loop them back to the readable side and
  // the adapter would re-parse its own replies.)
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

/** Build a stub dispatcher whose `dispatch` returns `result` and records calls. */
function makeStubDispatcher(
  result: DispatchResult | ((m: string, r: unknown) => DispatchResult | Promise<DispatchResult>),
): {
  dispatcher: Pick<Dispatcher, 'dispatch'>;
  calls: { method: string; req: unknown }[];
} {
  const calls: { method: string; req: unknown }[] = [];
  const dispatcher: Pick<Dispatcher, 'dispatch'> = {
    dispatch: vi.fn(async (method, req) => {
      calls.push({ method, req });
      return typeof result === 'function' ? result(method, req) : result;
    }),
  };
  return { dispatcher, calls };
}

const okResult: DispatchResult = { ok: true, value: { hello: 'world' }, ack_source: 'handler' };
const silentLogger = { warn: vi.fn() };

function buildJsonFrame(header: object): Buffer {
  return encodeFrame({ headerJson: Buffer.from(JSON.stringify(header), 'utf8') });
}

function decodeJsonHeader(frame: Buffer): Record<string, unknown> {
  const d = decodeFrame(frame);
  return JSON.parse(d.headerJson.toString('utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('mountEnvelopeAdapter — happy path', () => {
  it('decodes one well-formed frame, dispatches, and writes the encoded reply', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);

    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    const frame = buildJsonFrame({
      id: 42,
      method: '/healthz',
      payloadType: 'json',
      payloadLen: 0,
      traceId: '01HZZZTESTULIDXXXXXXXXXXXX',
    });
    feed(frame);

    // Let the microtask queue drain so the dispatcher promise resolves.
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('/healthz');
    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect(reply.id).toBe(42);
    expect(reply.ok).toBe(true);
    expect(reply.value).toEqual({ hello: 'world' });
    expect(reply.ack_source).toBe('handler');
    expect(destroyed()).toBe(false);
  });

  it('handles multiple frames in a single chunk', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    const a = buildJsonFrame({ id: 1, method: '/healthz', payloadType: 'json', payloadLen: 0 });
    const b = buildJsonFrame({ id: 2, method: '/stats', payloadType: 'json', payloadLen: 0 });
    feed(Buffer.concat([a, b]));
    await new Promise((r) => setImmediate(r));

    expect(calls.map((c) => c.method)).toEqual(['/healthz', '/stats']);
    expect(outbound.length).toBe(2);
    expect(decodeJsonHeader(outbound[0]!).id).toBe(1);
    expect(decodeJsonHeader(outbound[1]!).id).toBe(2);
  });

  it('forwards dispatcher error replies as { ok:false, error } envelopes without destroying', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const errResult: DispatchResult = {
      ok: false,
      error: { code: 'NOT_ALLOWED', method: 'session.list', message: 'forbidden' },
    };
    const { dispatcher } = makeStubDispatcher(errResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    feed(buildJsonFrame({ id: 7, method: 'session.list', payloadType: 'json', payloadLen: 0 }));
    await new Promise((r) => setImmediate(r));

    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect(reply.id).toBe(7);
    expect(reply.ok).toBe(false);
    expect((reply.error as { code: string }).code).toBe('NOT_ALLOWED');
    // Errors do NOT destroy — only protocol violations do.
    expect(destroyed()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Truncated read
// ---------------------------------------------------------------------------

describe('mountEnvelopeAdapter — truncated read', () => {
  it('does not dispatch until the second chunk arrives', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    const frame = buildJsonFrame({ id: 99, method: '/healthz', payloadType: 'json', payloadLen: 0 });
    // Split midway through the header bytes — neither half is a complete frame.
    const split = Math.floor(frame.length / 2);
    feed(frame.subarray(0, split));
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(0);
    expect(outbound.length).toBe(0);

    feed(frame.subarray(split));
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('/healthz');
    expect(outbound.length).toBe(1);
    expect(decodeJsonHeader(outbound[0]!).id).toBe(99);
  });

  it('handles a one-byte-at-a-time trickle without crashing', async () => {
    const { socket, feed, outbound } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    const frame = buildJsonFrame({ id: 5, method: '/healthz', payloadType: 'json', payloadLen: 0 });
    for (let i = 0; i < frame.length; i++) {
      feed(frame.subarray(i, i + 1));
    }
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(1);
    expect(outbound.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Oversized message
// ---------------------------------------------------------------------------

describe('mountEnvelopeAdapter — oversized message', () => {
  it('writes synthetic envelope_too_large reply with id: 0 and destroys the socket', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);
    const logger = { warn: vi.fn() };
    mountEnvelopeAdapter({ socket, dispatcher, logger, peerPid: 12345 });

    // Hand-craft a 4-byte prefix declaring 16 MiB + 1 byte payload (just the
    // prefix is enough — the cap-check fires before any body bytes are read).
    const oversize = ENVELOPE_LIMITS.MAX_PAYLOAD_BYTES + 1;
    const header = Buffer.alloc(4);
    // Nibble 0x0 (v0.3) in high bits, length in low 28 bits.
    header.writeUInt32BE(((0x0 & 0x0f) << 28) | (oversize & 0x0fffffff), 0);
    feed(header);
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(0);
    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect(reply.id).toBe(0);
    expect(reply.ok).toBe(false);
    expect((reply.error as { code: string }).code).toBe('envelope_too_large');
    expect(destroyed()).toBe(true);
    // Forensic warn line emitted with peerPid + len per spec §3.4.1.a.
    const warnedOversize = (
      logger.warn.mock.calls as Array<[Record<string, unknown>, string]>
    ).some(([obj, msg]) => msg === 'envelope_oversize' && obj.peerPid === 12345 && obj.len === oversize);
    expect(warnedOversize).toBe(true);
  });

  it('rejects unknown frame-version nibble before the cap-check (spec §3.4.1.a step 2)', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    // Nibble 0x1 (would be v0.4 protobuf) against a v0.3 daemon: reject with
    // UNSUPPORTED_FRAME_VERSION even if the masked length looks fine.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(((0x1 & 0x0f) << 28) | (16 & 0x0fffffff), 0);
    feed(header);
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(0);
    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect((reply.error as { code: string }).code).toBe('UNSUPPORTED_FRAME_VERSION');
    expect(destroyed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed JSON header
// ---------------------------------------------------------------------------

describe('mountEnvelopeAdapter — malformed JSON', () => {
  it('writes schema_violation reply and destroys the socket on garbage header bytes', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    // Build a syntactically valid frame whose header bytes are not JSON.
    const garbage = Buffer.from('not json at all', 'utf8');
    const frame = encodeFrame({ headerJson: garbage });
    feed(frame);
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(0);
    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect(reply.id).toBe(0);
    expect((reply.error as { code: string }).code).toBe('schema_violation');
    expect(destroyed()).toBe(true);
  });

  it('rejects a header that parses as JSON but is missing routing fields', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const { dispatcher, calls } = makeStubDispatcher(okResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    // Valid JSON, missing `method` (and id type wrong).
    feed(buildJsonFrame({ id: 'not-a-number', foo: 'bar' }));
    await new Promise((r) => setImmediate(r));

    expect(calls.length).toBe(0);
    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect((reply.error as { code: string }).code).toBe('schema_violation');
    expect(destroyed()).toBe(true);
  });

  it('rejects a header missing `method` while echoing back a valid `id`', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const { dispatcher } = makeStubDispatcher(okResult);
    mountEnvelopeAdapter({ socket, dispatcher, logger: silentLogger });

    feed(buildJsonFrame({ id: 33 }));
    await new Promise((r) => setImmediate(r));

    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect(reply.id).toBe(33);
    expect((reply.error as { code: string }).code).toBe('schema_violation');
    expect(destroyed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher exception handling
// ---------------------------------------------------------------------------

describe('mountEnvelopeAdapter — handler exceptions', () => {
  it('emits an INTERNAL error reply when the dispatcher throws (non-typed)', async () => {
    const { socket, feed, outbound, destroyed } = makeFakeSocket();
    const dispatcher: Pick<Dispatcher, 'dispatch'> = {
      dispatch: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const logger = { warn: vi.fn() };
    mountEnvelopeAdapter({ socket, dispatcher, logger });

    feed(buildJsonFrame({ id: 17, method: '/healthz', payloadType: 'json', payloadLen: 0 }));
    await new Promise((r) => setImmediate(r));

    expect(outbound.length).toBe(1);
    const reply = decodeJsonHeader(outbound[0]!);
    expect(reply.id).toBe(17);
    expect((reply.error as { code: string }).code).toBe('INTERNAL');
    // Socket NOT destroyed — handler exception is a per-call failure, not a
    // protocol violation. The connection stays usable for the next RPC.
    expect(destroyed()).toBe(false);
  });
});
