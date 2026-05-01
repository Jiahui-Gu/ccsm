// daemon/src/sockets/__tests__/route-data-socket-connection.test.ts
// T05.1 — coexistence router test: HTTP/2 preface vs envelope.

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  HTTP2_CLIENT_PREFACE,
  HTTP2_PREFACE_LENGTH,
  routeDataSocketConnection,
  type ConnectAttachable,
} from '../route-data-socket-connection.js';

function makeFakeSocket(): PassThrough {
  return new PassThrough();
}

describe('routeDataSocketConnection (T05.1)', () => {
  it('HTTP/2 client preface → routes to Connect server (attachSocket called)', async () => {
    const socket = makeFakeSocket();
    const attach = vi.fn();
    const envelope = vi.fn();
    const connectServer: ConnectAttachable = { attachSocket: attach };

    routeDataSocketConnection({
      socket: socket as any,
      connectServer,
      transportType: 'local-pipe',
      onEnvelopeConnection: envelope,
    });

    socket.write(Buffer.from(HTTP2_CLIENT_PREFACE, 'ascii'));
    // Allow the data event to propagate.
    await new Promise((r) => setImmediate(r));

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(socket, 'local-pipe');
    expect(envelope).not.toHaveBeenCalled();
  });

  it('non-HTTP/2 prefix → falls through to envelope dispatcher', async () => {
    const socket = makeFakeSocket();
    const attach = vi.fn();
    const envelope = vi.fn();
    const connectServer: ConnectAttachable = { attachSocket: attach };

    routeDataSocketConnection({
      socket: socket as any,
      connectServer,
      transportType: 'local-pipe',
      onEnvelopeConnection: envelope,
    });

    // First 24 bytes that are NOT the HTTP/2 preface — looks like a v0.3
    // length-prefixed envelope frame (4-byte length + JSON).
    const bogus = Buffer.alloc(HTTP2_PREFACE_LENGTH);
    bogus.write('XXXX{"hello":"world"}', 0, 'utf-8');
    socket.write(bogus);
    await new Promise((r) => setImmediate(r));

    expect(attach).not.toHaveBeenCalled();
    expect(envelope).toHaveBeenCalledTimes(1);
    expect(envelope).toHaveBeenCalledWith(socket);
  });

  it('connectServer === undefined → fast path: every connection goes to envelope', () => {
    const socket = makeFakeSocket();
    const envelope = vi.fn();

    routeDataSocketConnection({
      socket: socket as any,
      connectServer: undefined,
      transportType: 'local-pipe',
      onEnvelopeConnection: envelope,
    });

    expect(envelope).toHaveBeenCalledTimes(1);
    expect(envelope).toHaveBeenCalledWith(socket);
  });

  it('socket ends before preface bytes arrive → falls to envelope', async () => {
    const socket = makeFakeSocket();
    const attach = vi.fn();
    const envelope = vi.fn();
    const connectServer: ConnectAttachable = { attachSocket: attach };

    routeDataSocketConnection({
      socket: socket as any,
      connectServer,
      transportType: 'local-pipe',
      onEnvelopeConnection: envelope,
    });

    // Send a partial prefix (not enough to decide) then end the stream.
    socket.write(Buffer.from('PRI * ', 'ascii'));
    socket.end();
    await new Promise((r) => setImmediate(r));

    expect(attach).not.toHaveBeenCalled();
    expect(envelope).toHaveBeenCalledTimes(1);
  });

  it('preface arriving in two chunks still triggers Connect routing', async () => {
    const socket = makeFakeSocket();
    const attach = vi.fn();
    const envelope = vi.fn();
    const connectServer: ConnectAttachable = { attachSocket: attach };

    routeDataSocketConnection({
      socket: socket as any,
      connectServer,
      transportType: 'remote-tcp',
      onEnvelopeConnection: envelope,
    });

    const full = Buffer.from(HTTP2_CLIENT_PREFACE, 'ascii');
    socket.write(full.subarray(0, 10));
    await new Promise((r) => setImmediate(r));
    expect(attach).not.toHaveBeenCalled();
    socket.write(full.subarray(10));
    await new Promise((r) => setImmediate(r));
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(socket, 'remote-tcp');
  });
});
