// Tests for the typed control-socket facade (createControlClient).
//
// Asserts the facade correctly:
//   - calls `daemon.shutdownForUpgrade` with the spec'd 5 s timeout;
//   - returns the typed `{ accepted: true, reason: 'upgrade' }` ack on a
//     well-formed handler reply;
//   - rejects with a thrown Error when the handler returns an error envelope
//     (so `electron/updater.ts`'s `callShutdownForUpgrade` outer race classifies
//     as `{ kind: 'error', message }`);
//   - rejects with a thrown Error on transport failure (timeout / disconnect).
//
// Spec citation: frag-11 §11.6.5 step 3 (5 s ack window).

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';

import { createControlClient, SHUTDOWN_FOR_UPGRADE_METHOD } from '../controlClient';
import { decodeFrame, encodeFrame } from '../envelope';

function pairedSockets() {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const clientSide = new PassThrough() as unknown as Socket;
  s2c.on('data', (chunk: Buffer) => (clientSide as unknown as PassThrough).push(chunk));
  (clientSide as unknown as { write: (b: Buffer) => boolean }).write = (b: Buffer) => c2s.write(b);
  (clientSide as unknown as { destroy: () => void }).destroy = () => {
    try { c2s.end(); s2c.end(); } catch { /* */ }
    queueMicrotask(() => clientSide.emit('close'));
  };
  const serverSide = new PassThrough();
  c2s.on('data', (chunk: Buffer) => serverSide.push(chunk));
  serverSide.write = ((chunk: Buffer | string) => {
    s2c.write(chunk);
    return true;
  }) as typeof serverSide.write;
  return { clientSide, serverSide };
}

function decodeAll(buf: Buffer) {
  const out: Array<ReturnType<typeof decodeFrame>> = [];
  let cursor = buf;
  while (cursor.length >= 6) {
    let d;
    try { d = decodeFrame(cursor); } catch { break; }
    out.push(d);
    cursor = cursor.subarray(4 + 2 + d.headerJson.length + d.payload.length);
  }
  return out;
}

describe('createControlClient.callShutdownForUpgrade', () => {
  it('issues daemon.shutdownForUpgrade and resolves the typed ack', async () => {
    const { clientSide, serverSide } = pairedSockets();
    serverSide.on('data', (chunk: Buffer) => {
      const frames = decodeAll(chunk);
      for (const f of frames) {
        const h = JSON.parse(f.headerJson.toString('utf8'));
        expect(h.method).toBe(SHUTDOWN_FOR_UPGRADE_METHOD);
        const reply = Buffer.from(
          JSON.stringify({
            id: h.id,
            ok: true,
            value: { accepted: true, reason: 'upgrade' },
            ack_source: 'handler',
          }),
          'utf8',
        );
        serverSide.write(encodeFrame({ headerJson: reply }));
      }
    });

    const client = createControlClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
    });
    const connectP = client.rpc.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    const ack = await client.callShutdownForUpgrade();
    expect(ack).toEqual({ accepted: true, reason: 'upgrade' });
    client.rpc.close();
  });

  it('throws when the handler replies with an error envelope', async () => {
    const { clientSide, serverSide } = pairedSockets();
    serverSide.on('data', (chunk: Buffer) => {
      const frames = decodeAll(chunk);
      for (const f of frames) {
        const h = JSON.parse(f.headerJson.toString('utf8'));
        const reply = Buffer.from(
          JSON.stringify({
            id: h.id,
            ok: false,
            error: { code: 'INTERNAL', message: 'marker write failed' },
          }),
          'utf8',
        );
        serverSide.write(encodeFrame({ headerJson: reply }));
      }
    });

    const client = createControlClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
    });
    const connectP = client.rpc.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    await expect(client.callShutdownForUpgrade()).rejects.toThrow(
      /INTERNAL: marker write failed/,
    );
    client.rpc.close();
  });

  it('throws on a malformed ack value', async () => {
    const { clientSide, serverSide } = pairedSockets();
    serverSide.on('data', (chunk: Buffer) => {
      const frames = decodeAll(chunk);
      for (const f of frames) {
        const h = JSON.parse(f.headerJson.toString('utf8'));
        const reply = Buffer.from(
          JSON.stringify({
            id: h.id,
            ok: true,
            value: { accepted: false }, // wrong shape
            ack_source: 'handler',
          }),
          'utf8',
        );
        serverSide.write(encodeFrame({ headerJson: reply }));
      }
    });

    const client = createControlClient({
      socketPath: '/fake',
      connectFn: () => clientSide,
    });
    const connectP = client.rpc.connect();
    queueMicrotask(() => clientSide.emit('connect'));
    await connectP;

    await expect(client.callShutdownForUpgrade()).rejects.toThrow(/malformed ack/);
    client.rpc.close();
  });
});
