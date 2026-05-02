// Tests for the Electron-side socket-RPC client (Task #27 / B7b).
//
// Strategy:
//   - Use a fake `connectFn` that returns a `PassThrough`-paired duplex so
//     we can drive both sides of the wire deterministically (no real net
//     listener, no port races).
//   - For the e2e parity case we mount the daemon-side envelope adapter
//     (`daemon/src/envelope/adapter.ts`) on the server-side duplex with a
//     stub dispatcher that returns a known reply, and assert the client's
//     `call(...)` resolves to the typed `{ ok, value, ack_source }` shape.
//
// Spec citations:
//   - frag-3.4.1 §3.4.1.c reply shape `{ id, ok, value, ack_source }`.
//   - frag-3.4.1 §3.4.1.h control-socket plane (the rpcClient is transport-
//     agnostic; the test just speaks to a duplex).

import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { PassThrough, type Duplex } from 'node:stream';
import type { Socket } from 'node:net';

import { createRpcClient } from '../rpcClient';
import { decodeFrame, encodeFrame } from '../envelope';

// ---------------------------------------------------------------------------
// Test harness — paired duplex that pretends to be a `net.Socket`.
// ---------------------------------------------------------------------------

function pairedSockets(): {
  clientSide: Socket; // what `connectFn` returns
  serverSide: Duplex; // what we mount the daemon adapter on
} {
  // Two PassThroughs, cross-piped: writes on one show up as reads on the
  // other. The `clientSide` PassThrough also gets two extra Socket-shaped
  // helpers (`emit('connect')`, `destroy()`) the rpcClient relies on.
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  const clientSide = new PassThrough() as unknown as Socket;
  // Reads on clientSide come from s2c.
  s2c.on('data', (chunk: Buffer) => (clientSide as unknown as PassThrough).push(chunk));
  s2c.on('end', () => (clientSide as unknown as PassThrough).push(null));
  // Writes on clientSide go to c2s.
  (clientSide as unknown as { write: (b: Buffer) => boolean }).write = (b: Buffer) => c2s.write(b);
  // destroy() ends both halves so the rpcClient's `close` listener fires.
  (clientSide as unknown as { destroy: () => void }).destroy = () => {
    try { c2s.end(); } catch { /* */ }
    try { s2c.end(); } catch { /* */ }
    (clientSide as unknown as PassThrough).push(null);
    queueMicrotask(() => clientSide.emit('close'));
  };

  const serverSide = new PassThrough();
  // Server reads from c2s; writes from server go to s2c.
  c2s.on('data', (chunk: Buffer) => serverSide.push(chunk));
  c2s.on('end', () => serverSide.push(null));
  serverSide.write = ((chunk: Buffer | string) => {
    s2c.write(chunk);
    return true;
  }) as typeof serverSide.write;

  return { clientSide, serverSide };
}

function decodeAllFrames(buf: Buffer): Array<ReturnType<typeof decodeFrame>> {
  const out: Array<ReturnType<typeof decodeFrame>> = [];
  let cursor = buf;
  while (cursor.length >= 6) {
    let decoded;
    try {
      decoded = decodeFrame(cursor);
    } catch {
      break;
    }
    out.push(decoded);
    const consumed = 4 + 2 + decoded.headerJson.length + decoded.payload.length;
    cursor = cursor.subarray(consumed);
  }
  return out;
}

describe('rpcClient — happy path', () => {
  it('encodes a request frame with monotonic id, method, payloadType=json', async () => {
    const { clientSide, serverSide } = pairedSockets();
    const captured: Buffer[] = [];
    serverSide.on('data', (chunk: Buffer) => captured.push(chunk));

    const client = createRpcClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
      reconnectBackoffMs: [],
    });
    const connectP = client.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    // Fire the call — don't await yet; the server hasn't replied.
    const callP = client.call('daemon.shutdownForUpgrade', undefined, { timeoutMs: 0 });

    // Allow the write to land on serverSide.
    await new Promise<void>((r) => setImmediate(r));

    const all = Buffer.concat(captured);
    const frames = decodeAllFrames(all);
    expect(frames).toHaveLength(1);
    const header = JSON.parse(frames[0]!.headerJson.toString('utf8'));
    expect(header).toMatchObject({
      id: 1,
      method: 'daemon.shutdownForUpgrade',
      payloadType: 'json',
      payloadLen: 0,
    });

    // Ship a reply so the call resolves and we don't leak the promise.
    const replyHeader = Buffer.from(
      JSON.stringify({
        id: 1,
        ok: true,
        value: { accepted: true, reason: 'upgrade' },
        ack_source: 'handler',
      }),
      'utf8',
    );
    serverSide.write(encodeFrame({ headerJson: replyHeader }));

    const reply = await callP;
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.value).toEqual({ accepted: true, reason: 'upgrade' });
      expect(reply.ack_source).toBe('handler');
    }
    client.close();
  });

  it('correlates concurrent calls by id', async () => {
    const { clientSide, serverSide } = pairedSockets();
    const captured: Buffer[] = [];
    serverSide.on('data', (chunk: Buffer) => {
      captured.push(chunk);
      // Auto-reply: parse every newly-arrived frame and reply in REVERSE
      // order so we exercise out-of-order id correlation.
      const all = Buffer.concat(captured);
      const frames = decodeAllFrames(all);
      if (frames.length === 2) {
        for (const f of frames.slice().reverse()) {
          const h = JSON.parse(f.headerJson.toString('utf8'));
          serverSide.write(
            encodeFrame({
              headerJson: Buffer.from(
                JSON.stringify({ id: h.id, ok: true, value: { echo: h.id }, ack_source: 'handler' }),
                'utf8',
              ),
            }),
          );
        }
      }
    });

    const client = createRpcClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
      reconnectBackoffMs: [],
    });
    const connectP = client.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    const [a, b] = await Promise.all([
      client.call<{ echo: number }>('m.A'),
      client.call<{ echo: number }>('m.B'),
    ]);
    expect(a.ok && a.value.echo).toBe(1);
    expect(b.ok && b.value.echo).toBe(2);
    client.close();
  });
});

describe('rpcClient — error paths', () => {
  it('rejects with RPC_TIMEOUT when no reply arrives in time', async () => {
    const { clientSide } = pairedSockets();
    const client = createRpcClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
      reconnectBackoffMs: [],
    });
    const connectP = client.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    const callP = client.call('m.never', undefined, { timeoutMs: 25 });
    await expect(callP).rejects.toMatchObject({
      name: 'RpcTransportError',
      code: 'RPC_TIMEOUT',
    });
    client.close();
  });

  it('rejects pending calls with RPC_DISCONNECTED on socket close', async () => {
    const { clientSide } = pairedSockets();
    const client = createRpcClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
      reconnectBackoffMs: [],
    });
    const connectP = client.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    const callP = client.call('m.never', undefined, { timeoutMs: 0 });
    // Wait for the request to land before closing.
    await new Promise<void>((r) => setImmediate(r));
    clientSide.destroy();

    await expect(callP).rejects.toMatchObject({
      name: 'RpcTransportError',
      code: 'RPC_DISCONNECTED',
    });
  });

  it('schedules a reconnect with backoff after an unsolicited socket close', async () => {
    let connectCount = 0;
    const sockets: ReturnType<typeof pairedSockets>[] = [];
    const client = createRpcClient({
      socketPath: '/fake',
      // Each connect() call returns a fresh pair so we can count attempts.
      connectFn: () => {
        const pair = pairedSockets();
        sockets.push(pair);
        connectCount += 1;
        // Synchronously schedule the connect event so .connect() resolves.
        queueMicrotask(() => pair.clientSide.emit('connect'));
        return pair.clientSide;
      },
      reconnectBackoffMs: [10, 10, 10],
    });
    await client.connect();
    expect(connectCount).toBe(1);

    // Drop the live socket. The client should schedule a reconnect.
    sockets[0]!.clientSide.destroy();
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(connectCount).toBeGreaterThanOrEqual(2);
    client.close();
  });

  it('rejects new calls after close()', async () => {
    const { clientSide } = pairedSockets();
    const client = createRpcClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
      reconnectBackoffMs: [],
    });
    const connectP = client.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    client.close();
    await expect(client.call('m.x')).rejects.toMatchObject({
      code: 'RPC_NOT_CONNECTED',
    });
  });
});

describe('rpcClient — daemon adapter parity (e2e via paired duplex)', () => {
  it('round-trips daemon.shutdownForUpgrade through the real adapter', async () => {
    const { mountEnvelopeAdapter } = await import('../../../daemon/src/envelope/adapter.js');
    const { clientSide, serverSide } = pairedSockets();

    const dispatcher = {
      dispatch: vi.fn(async (method: string) => {
        if (method === 'daemon.shutdownForUpgrade') {
          return {
            ok: true as const,
            value: { accepted: true, reason: 'upgrade' },
            ack_source: 'handler' as const,
          };
        }
        return {
          ok: false as const,
          error: { code: 'UNKNOWN_METHOD', message: 'unknown', method },
        };
      }),
    };

    mountEnvelopeAdapter({
      socket: serverSide as unknown as Parameters<typeof mountEnvelopeAdapter>[0]['socket'],
      dispatcher,
      logger: { warn: () => {} },
      peer: 'test',
    });

    const client = createRpcClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
      reconnectBackoffMs: [],
    });
    const connectP = client.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    const reply = await client.call('daemon.shutdownForUpgrade');
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.value).toEqual({ accepted: true, reason: 'upgrade' });
      expect(reply.ack_source).toBe('handler');
    }
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      'daemon.shutdownForUpgrade',
      expect.objectContaining({ id: 1, method: 'daemon.shutdownForUpgrade' }),
      expect.any(Object),
    );
    client.close();
  });
});
