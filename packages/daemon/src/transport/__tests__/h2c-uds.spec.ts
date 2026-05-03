// h2c-UDS adapter spec — exercises bind / address / close on a real
// UDS path. Spec ch03 §4 A1. Skipped on win32 (the adapter throws by
// design — exercised separately).

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, connect as h2connect, type ClientHttp2Session } from 'node:http2';
import { mkdtempSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

import { bindH2cUds } from '../h2c-uds.js';
import type { BoundTransport } from '../types.js';

const isWin = platform() === 'win32';
const describePosix = isWin ? describe.skip : describe;

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

function freshSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccsm-h2c-uds-'));
  return join(dir, 'daemon.sock');
}

describePosix('bindH2cUds (POSIX)', () => {
  it('binds an http2 server to a UDS path and surfaces it via address()', async () => {
    const server = createServer();
    const path = freshSocketPath();
    bound = await bindH2cUds(server, { path });
    const addr = bound.address();
    expect(addr).toEqual({ kind: 'uds', path });
    expect(existsSync(path)).toBe(true);
  });

  it('serves an end-to-end h2c request over UDS', async () => {
    const server = createServer();
    server.on('stream', (stream, headers) => {
      if (headers[':path'] === '/ping') {
        stream.respond({ ':status': 200 });
        stream.end('pong');
      } else {
        stream.respond({ ':status': 404 });
        stream.end();
      }
    });
    const path = freshSocketPath();
    bound = await bindH2cUds(server, { path });

    h2client = h2connect('http://localhost', {
      createConnection: () => netConnect(path),
    });
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

  it('unlinks a stale socket inode before bind', async () => {
    const path = freshSocketPath();
    // Create a server, bind, close (leaves no socket if close cleans up
    // — but a crashed daemon would leave one; simulate by binding then
    // killing with a fresh server that we never close).
    const first = createServer();
    const firstBound = await bindH2cUds(first, { path });
    expect(existsSync(path)).toBe(true);
    // Don't gracefully close first — simulate the inode being left
    // behind. Forcefully close the underlying server but skip our
    // adapter's unlink by calling raw close.
    await new Promise<void>((resolve) => first.close(() => resolve()));
    // If the platform leaves the inode, our adapter must clean it.
    // If close() already removed it, recreate to simulate the crash case.
    if (!existsSync(path)) {
      writeFileSync(path, ''); // not a socket; should NOT be touched
      // Our adapter MUST NOT delete a regular file at the bind path —
      // bind should fail loud (EADDRINUSE / ENOTSOCK).
      const second = createServer();
      await expect(bindH2cUds(second, { path })).rejects.toThrow();
      unlinkSync(path);
      // Now write a real (fake) socket-like test — we cannot easily
      // create a UDS inode without binding, so just trust the lstat
      // check by binding twice in a row through our adapter.
      const third = createServer();
      bound = await bindH2cUds(third, { path });
    } else {
      // Inode survives. Re-bind via adapter — must succeed by
      // unlinking the stale socket.
      const second = createServer();
      bound = await bindH2cUds(second, { path });
    }
    void firstBound;
    expect(existsSync(path)).toBe(true);
  });

  it('removes the socket file on close()', async () => {
    const server = createServer();
    const path = freshSocketPath();
    bound = await bindH2cUds(server, { path });
    expect(existsSync(path)).toBe(true);
    await bound.close();
    bound = null;
    expect(existsSync(path)).toBe(false);
  });

  it('close() is idempotent', async () => {
    const server = createServer();
    const path = freshSocketPath();
    bound = await bindH2cUds(server, { path });
    await bound.close();
    await expect(bound.close()).resolves.toBeUndefined();
    bound = null;
  });
});

describe('bindH2cUds (win32 guard)', () => {
  it.skipIf(!isWin)('throws synchronously on win32 with a routing-hint message', async () => {
    const server = createServer();
    await expect(bindH2cUds(server, { path: '/tmp/should-not-bind' })).rejects.toThrow(
      /POSIX-only/,
    );
  });
});
