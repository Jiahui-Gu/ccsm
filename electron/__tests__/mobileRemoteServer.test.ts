import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';

// Mock the ptyHost surface the server consumes. We don't want a real PTY,
// and pulling in ../ptyHost would drag node-pty + electron transitively.
vi.mock('../ptyHost', () => {
  const listeners: Array<(sid: string, chunk: string) => void> = [];
  return {
    listPtySessions: vi.fn(() => [{ sid: 'mock-sid', cols: 80, rows: 24 }]),
    getPtySession: vi.fn((sid: string) =>
      sid === 'mock-sid' ? { sid, cols: 80, rows: 24 } : null
    ),
    inputPtySession: vi.fn(),
    getBufferSnapshot: vi.fn(async (_sid: string) => ({ snapshot: 'hello\r\n' })),
    onPtyData: vi.fn((cb: (sid: string, chunk: string) => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    }),
  };
});

type Started = {
  port: number;
  token: string;
  close: () => void;
};

async function startServer(): Promise<Started> {
  // Capture the random token from the server's startup console.log line.
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  process.env.CCSM_MOBILE_REMOTE = '1';
  // Pick a port deterministically by asking the OS for a free one, then
  // freeing it before the server binds. Cheap-and-cheerful for tests.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  process.env.CCSM_MOBILE_REMOTE_PORT = String(port);

  // Fresh module so the token is regenerated per test.
  vi.resetModules();
  const { startMobileRemoteServer } = await import('../remote/mobileRemoteServer');
  const handle = startMobileRemoteServer();
  if (!handle) throw new Error('server did not start');

  // Wait for the "listening at" log line that contains the token.
  let token: string | null = null;
  for (let i = 0; i < 50 && !token; i += 1) {
    for (const call of logSpy.mock.calls) {
      const line = String(call[0] ?? '');
      const m = line.match(/token=([A-Za-z0-9_-]+)/);
      if (m) {
        token = m[1]!;
        break;
      }
    }
    if (!token) await new Promise((r) => setTimeout(r, 10));
  }
  logSpy.mockRestore();
  if (!token) throw new Error('could not capture token from startup log');

  return {
    port,
    token,
    close: () => handle.close(),
  };
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Minimal client-side WebSocket handshake + framing helpers. We deliberately
// avoid pulling in `ws` so this stays a zero-dep test.
type WsHandle = {
  socket: Socket;
  recvText: Promise<string[]>;
  /** Returns the next not-yet-consumed text message, waiting up to `timeoutMs`. */
  nextMessage: (timeoutMs?: number) => Promise<string>;
  closeCode: Promise<number | null>;
};

function wsConnect(port: number, path: string): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      // Server rejected (401 etc.) — surface the status for the caller.
      const status = res.statusCode ?? 0;
      reject(new Error(`upgrade rejected: ${status}`));
    });
    req.on('upgrade', (_res, socket, head) => {
      const messages: string[] = [];
      let cursor = 0;
      const waiters: Array<(m: string) => void> = [];
      let closeCode: number | null = null;
      let buffer = Buffer.from(head);
      let resolveText: ((m: string[]) => void) | null = null;
      let resolveClose: ((c: number | null) => void) | null = null;
      const recvText = new Promise<string[]>((r) => {
        resolveText = r;
      });
      const closePromise = new Promise<number | null>((r) => {
        resolveClose = r;
      });

      const tryDrain = () => {
        let offset = 0;
        while (offset + 2 <= buffer.length) {
          const first = buffer[offset]!;
          const second = buffer[offset + 1]!;
          const opcode = first & 0x0f;
          let length = second & 0x7f;
          let headerLen = 2;
          if (length === 126) {
            if (offset + 4 > buffer.length) break;
            length = buffer.readUInt16BE(offset + 2);
            headerLen = 4;
          } else if (length === 127) {
            if (offset + 10 > buffer.length) break;
            length = Number(buffer.readBigUInt64BE(offset + 2));
            headerLen = 10;
          }
          if (offset + headerLen + length > buffer.length) break;
          const payload = buffer.subarray(offset + headerLen, offset + headerLen + length);
          if (opcode === 0x1) {
            messages.push(payload.toString('utf8'));
            const w = waiters.shift();
            if (w) w(messages[messages.length - 1]!);
          } else if (opcode === 0x8) {
            closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
          }
          offset += headerLen + length;
        }
        buffer = buffer.subarray(offset);
      };

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        tryDrain();
        if (messages.length >= 2 && resolveText) {
          resolveText(messages.slice());
          cursor = messages.length;
          resolveText = null;
        }
      });
      socket.on('close', () => {
        if (resolveClose) resolveClose(closeCode);
      });
      socket.on('error', () => {
        if (resolveClose) resolveClose(closeCode);
      });

      const nextMessage = (timeoutMs = 2000): Promise<string> => {
        if (cursor < messages.length) {
          return Promise.resolve(messages[cursor++]!);
        }
        return new Promise<string>((res, rej) => {
          const t = setTimeout(() => rej(new Error('nextMessage timed out')), timeoutMs);
          waiters.push((m) => {
            clearTimeout(t);
            cursor = messages.length;
            res(m);
          });
        });
      };

      resolve({ socket: socket as Socket, recvText, nextMessage, closeCode: closePromise });
      // The upgrade response may carry initial server frames in `head` —
      // drain synchronously so auth.ok / sessions.list don't wait for a
      // later 'data' event that may never come if the server has nothing
      // more to send.
      tryDrain();
      if (messages.length >= 2 && resolveText) {
        resolveText(messages.slice());
        cursor = messages.length;
        resolveText = null;
      }
    });
    req.end();
  });
}

/** Encode a client (masked) WebSocket text frame. */
function encodeClientText(payload: string, opts: { fin?: boolean; opcode?: number } = {}): Buffer {
  const body = Buffer.from(payload, 'utf8');
  return encodeClientFrame(body, opts);
}

function encodeClientFrame(
  body: Buffer,
  opts: { fin?: boolean; opcode?: number } = {}
): Buffer {
  const fin = opts.fin ?? true;
  const opcode = opts.opcode ?? 0x1;
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i]! ^ mask[i % 4]!;

  let header: Buffer;
  if (body.length < 126) {
    header = Buffer.from([firstByte, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

let active: Started | null = null;
beforeEach(() => {
  active = null;
});
afterEach(async () => {
  if (active) {
    active.close();
    active = null;
  }
  delete process.env.CCSM_MOBILE_REMOTE;
  delete process.env.CCSM_MOBILE_REMOTE_PORT;
  // Let the OS reclaim the listening socket between tests.
  await new Promise((r) => setTimeout(r, 10));
});

describe('mobileRemoteServer: env gate', () => {
  it('returns null when CCSM_MOBILE_REMOTE is unset', async () => {
    delete process.env.CCSM_MOBILE_REMOTE;
    vi.resetModules();
    const { startMobileRemoteServer } = await import('../remote/mobileRemoteServer');
    expect(startMobileRemoteServer()).toBeNull();
  });
});

describe('mobileRemoteServer: HTTP token auth', () => {
  it('rejects unauthenticated GET / with 401', async () => {
    active = await startServer();
    const res = await httpGet(active.port, '/');
    expect(res.status).toBe(401);
    expect(res.body).toMatch(/Unauthorized/);
  });

  it('rejects wrong-token GET / with 401', async () => {
    active = await startServer();
    const res = await httpGet(active.port, '/?token=not-the-token');
    expect(res.status).toBe(401);
  });

  it('serves the mobile page on correct token', async () => {
    active = await startServer();
    const res = await httpGet(active.port, `/?token=${active.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/CCSM Mobile Remote/);
  });

  it('returns 404 for unknown paths even with valid token', async () => {
    active = await startServer();
    const res = await httpGet(active.port, `/nope?token=${active.token}`);
    expect(res.status).toBe(404);
  });
});

describe('mobileRemoteServer: WebSocket token auth', () => {
  it('rejects upgrade without a token', async () => {
    active = await startServer();
    await expect(wsConnect(active.port, '/ws')).rejects.toThrow(/401/);
  });

  it('rejects upgrade with a wrong token', async () => {
    active = await startServer();
    await expect(wsConnect(active.port, '/ws?token=bogus')).rejects.toThrow(/401/);
  });

  it('rejects upgrade to a non-/ws path with valid token', async () => {
    active = await startServer();
    await expect(
      wsConnect(active.port, `/notws?token=${active.token}`)
    ).rejects.toThrow(/401/);
  });

  it('accepts upgrade with valid token and emits auth.ok + sessions.list', async () => {
    active = await startServer();
    const ws = await wsConnect(active.port, `/ws?token=${active.token}`);
    const msgs = await ws.recvText;
    const parsed = msgs.map((m) => JSON.parse(m));
    expect(parsed[0]).toEqual({ type: 'auth.ok' });
    expect(parsed[1].type).toBe('sessions.list');
    expect(Array.isArray(parsed[1].sessions)).toBe(true);
    ws.socket.destroy();
  });
});

describe('mobileRemoteServer: 1 MiB message cap', () => {
  const CAP = 1 << 20;

  it('accepts a text message just under 1 MiB', async () => {
    active = await startServer();
    const ws = await wsConnect(active.port, `/ws?token=${active.token}`);
    // Drain initial auth.ok + sessions.list.
    await ws.recvText;

    // Send a session.input frame with a data payload sized so the *whole*
    // JSON message is just under the cap (CAP - 1 bytes after framing).
    const overhead = JSON.stringify({ type: 'session.input', sid: 'mock-sid', data: '' }).length;
    const fillLen = CAP - overhead - 1;
    const msg = JSON.stringify({
      type: 'session.input',
      sid: 'mock-sid',
      data: 'a'.repeat(fillLen),
    });
    expect(msg.length).toBe(CAP - 1);

    ws.socket.write(encodeClientText(msg));
    // No close frame should arrive — give it a moment, then check.
    const raced = await Promise.race([
      ws.closeCode,
      new Promise<'still-open'>((r) => setTimeout(() => r('still-open'), 150)),
    ]);
    expect(raced).toBe('still-open');
    ws.socket.destroy();
  });

  it('rejects a text message just over 1 MiB with close code 1009', async () => {
    active = await startServer();
    const ws = await wsConnect(active.port, `/ws?token=${active.token}`);
    await ws.recvText;

    // One byte past the cap — server should close with 1009 (message too big).
    const payload = 'x'.repeat(CAP + 1);
    ws.socket.write(encodeClientText(payload));

    const code = await Promise.race([
      ws.closeCode,
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error('no close')), 2000)),
    ]);
    // Server flushes the close frame (via socket.end) before FIN, so the peer
    // must observe the exact 1009 reason on every OS.
    expect(code).toBe(1009);
  });
});

describe('mobileRemoteServer: message handling', () => {
  it('replies with sessions.list on demand', async () => {
    active = await startServer();
    const ws = await wsConnect(active.port, `/ws?token=${active.token}`);
    await ws.recvText;

    ws.socket.write(encodeClientText(JSON.stringify({ type: 'sessions.list' })));
    const text = await ws.nextMessage();
    expect(JSON.parse(text).type).toBe('sessions.list');
    ws.socket.destroy();
  });

  it('responds with error on invalid JSON', async () => {
    active = await startServer();
    const ws = await wsConnect(active.port, `/ws?token=${active.token}`);
    await ws.recvText;

    ws.socket.write(encodeClientText('{not json'));
    const parsed = JSON.parse(await ws.nextMessage());
    expect(parsed).toEqual({ type: 'error', message: 'invalid_json' });
    ws.socket.destroy();
  });

  it('responds with error on unknown message type', async () => {
    active = await startServer();
    const ws = await wsConnect(active.port, `/ws?token=${active.token}`);
    await ws.recvText;

    ws.socket.write(encodeClientText(JSON.stringify({ type: 'totally.unknown' })));
    const parsed = JSON.parse(await ws.nextMessage());
    expect(parsed).toEqual({ type: 'error', message: 'unknown_type' });
    ws.socket.destroy();
  });

  it('closes with 1003 on binary data frame (text-only protocol)', async () => {
    active = await startServer();
    const ws = await wsConnect(active.port, `/ws?token=${active.token}`);
    await ws.recvText;

    // Opcode 0x2 = binary; server protocol is text-only.
    ws.socket.write(encodeClientFrame(Buffer.from([0, 1, 2, 3]), { opcode: 0x2 }));
    const code = await Promise.race([
      ws.closeCode,
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error('no close')), 1000)),
    ]);
    expect(code).toBe(1003);
  });
});
