// h2-named-pipe adapter spec — exercises bind / address / close on a
// real Windows named pipe. Spec ch03 §4 A4. Skipped off-win32 (the
// adapter throws by design — exercised separately).

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, connect as h2connect, type ClientHttp2Session } from 'node:http2';
import { connect as netConnect } from 'node:net';
import { platform } from 'node:os';

import { bindH2NamedPipe, normalizePipePath } from '../h2-named-pipe.js';
import type { BoundTransport } from '../types.js';

const isWin = platform() === 'win32';
const describeWin = isWin ? describe : describe.skip;

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

function freshPipeName(): string {
  // Per-test unique name to avoid cross-test interference.
  const id = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return `ccsm-test-${id}`;
}

describe('normalizePipePath', () => {
  it('passes through \\\\?\\pipe\\... unchanged', () => {
    expect(normalizePipePath('\\\\?\\pipe\\foo')).toBe('\\\\?\\pipe\\foo');
  });
  it('passes through \\\\.\\pipe\\... unchanged', () => {
    expect(normalizePipePath('\\\\.\\pipe\\foo')).toBe('\\\\.\\pipe\\foo');
  });
  it('prefixes a bare name with \\\\?\\pipe\\', () => {
    expect(normalizePipePath('foo')).toBe('\\\\?\\pipe\\foo');
  });
});

describeWin('bindH2NamedPipe (win32)', () => {
  it('binds an http2 server to a named pipe and surfaces it via address()', async () => {
    const server = createServer();
    const pipe = freshPipeName();
    bound = await bindH2NamedPipe(server, { pipeName: pipe });
    const addr = bound.address();
    expect(addr).toEqual({ kind: 'namedPipe', pipeName: `\\\\?\\pipe\\${pipe}` });
  });

  it('serves an end-to-end h2 request over the pipe', async () => {
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
    const pipe = freshPipeName();
    bound = await bindH2NamedPipe(server, { pipeName: pipe });
    const pipePath = `\\\\?\\pipe\\${pipe}`;

    h2client = h2connect('http://localhost', {
      createConnection: () => netConnect(pipePath),
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

  it('close() is idempotent', async () => {
    const server = createServer();
    const pipe = freshPipeName();
    bound = await bindH2NamedPipe(server, { pipeName: pipe });
    await bound.close();
    await expect(bound.close()).resolves.toBeUndefined();
    bound = null;
  });
});

describe('bindH2NamedPipe (POSIX guard)', () => {
  it.skipIf(isWin)('throws synchronously on POSIX with a routing-hint message', async () => {
    const server = createServer();
    await expect(bindH2NamedPipe(server, { pipeName: 'never-binds' })).rejects.toThrow(
      /win32-only/,
    );
  });
});
