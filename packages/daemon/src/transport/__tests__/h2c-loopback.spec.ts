// h2c-loopback adapter spec — exercises bind / address / close on a
// real ephemeral 127.0.0.1 listener. Spec ch03 §4 A2.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http2';
import { connect as h2connect, type ClientHttp2Session } from 'node:http2';

import { bindH2cLoopback } from '../h2c-loopback.js';
import type { BoundTransport } from '../types.js';

let bound: BoundTransport | null = null;
let h2client: ClientHttp2Session | null = null;

afterEach(async () => {
  if (h2client) {
    h2client.destroy();
    h2client = null;
  }
  if (bound) {
    await bound.close();
    bound = null;
  }
});

describe('bindH2cLoopback', () => {
  it('binds an ephemeral 127.0.0.1 port and surfaces it via address()', async () => {
    const server = createServer();
    bound = await bindH2cLoopback(server, { host: '127.0.0.1', port: 0 });
    const addr = bound.address();
    expect(addr.kind).toBe('KIND_TCP_LOOPBACK_H2C');
    if (addr.kind !== 'KIND_TCP_LOOPBACK_H2C') throw new Error('unreachable');
    expect(addr.host).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
    expect(addr.port).toBeLessThan(65536);
  });

  it('serves an end-to-end h2c request to a stream handler', async () => {
    const server = createServer();
    server.on('stream', (stream, headers) => {
      const path = headers[':path'];
      if (path === '/ping') {
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end('pong');
        return;
      }
      stream.respond({ ':status': 404 });
      stream.end();
    });
    bound = await bindH2cLoopback(server, { host: '127.0.0.1', port: 0 });
    const addr = bound.address();
    if (addr.kind !== 'KIND_TCP_LOOPBACK_H2C') throw new Error('unreachable');

    h2client = h2connect(`http://127.0.0.1:${addr.port}`);
    const body = await new Promise<string>((resolve, reject) => {
      const req = h2client!.request({ ':path': '/ping' });
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('pong');
  });

  it('rejects non-loopback host at runtime', async () => {
    const server = createServer();
    await expect(
      bindH2cLoopback(server, { host: '0.0.0.0' as '127.0.0.1', port: 0 }),
    ).rejects.toThrow(/MUST be 127\.0\.0\.1/);
  });

  it('rejects out-of-range port', async () => {
    const server = createServer();
    await expect(
      bindH2cLoopback(server, { host: '127.0.0.1', port: 70_000 }),
    ).rejects.toThrow(/port out of range/);
  });

  it('close() is idempotent', async () => {
    const server = createServer();
    bound = await bindH2cLoopback(server, { host: '127.0.0.1', port: 0 });
    await bound.close();
    // Second call returns the same Promise — must NOT throw.
    await expect(bound.close()).resolves.toBeUndefined();
    bound = null; // already closed; afterEach skip
  });
});
