// Unit tests for daemon tunnel client (Task #779, S3-T3).
//
// Mocks ws via DI seam (TunnelClientOptions.wsFactory). No real network.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import { TunnelClient, type WsLike } from '../src/tunnel.mjs';

// ---- Fake socket --------------------------------------------------------

interface FakeSocket extends WsLike {
  // Test helpers:
  open(): void;
  closeFromServer(code: number): void;
  pushBinary(data: Buffer): void;
  pushText(data: string): void;
  errorOut(msg: string): void;
  // Spies:
  sent: Array<Buffer | string | Uint8Array>;
  closedCalls: Array<{ code?: number; reason?: string }>;
  url: string;
}

function makeFakeSocket(url: string): FakeSocket {
  const handlers: {
    open: Array<() => void>;
    message: Array<(data: Buffer, isBinary: boolean) => void>;
    close: Array<(code: number, reason: Buffer) => void>;
    error: Array<(err: Error) => void>;
  } = { open: [], message: [], close: [], error: [] };

  const sock: FakeSocket = {
    url,
    readyState: 0,
    sent: [],
    closedCalls: [],
    on(event: string, cb: unknown): void {
      // Strong-typed dispatch.
      if (event === 'open') handlers.open.push(cb as () => void);
      else if (event === 'message')
        handlers.message.push(cb as (d: Buffer, b: boolean) => void);
      else if (event === 'close')
        handlers.close.push(cb as (c: number, r: Buffer) => void);
      else if (event === 'error') handlers.error.push(cb as (e: Error) => void);
    },
    send(data) {
      sock.sent.push(data);
    },
    close(code, reason) {
      sock.closedCalls.push({ code, reason });
      // Fire close handlers (some real-ws impls do; we mirror).
      for (const h of handlers.close) h(code ?? 1000, Buffer.from(reason ?? ''));
    },
    open() {
      sock.readyState = 1;
      for (const h of handlers.open) h();
    },
    closeFromServer(code: number) {
      sock.readyState = 3;
      for (const h of handlers.close) h(code, Buffer.alloc(0));
    },
    pushBinary(data: Buffer) {
      for (const h of handlers.message) h(data, true);
    },
    pushText(data: string) {
      for (const h of handlers.message) h(Buffer.from(data, 'utf8'), false);
    },
    errorOut(msg: string) {
      for (const h of handlers.error) h(new Error(msg));
    },
  };
  return sock;
}

// ---- Tests --------------------------------------------------------------

describe('TunnelClient', () => {
  let factory: Mock<(url: string) => WsLike>;
  let sockets: FakeSocket[];

  beforeEach(() => {
    sockets = [];
    factory = vi.fn((url: string) => {
      const s = makeFakeSocket(url);
      sockets.push(s);
      return s;
    });
    // Pin Math.random so jitter factor = 1 (1 + (0.5*2-1)*0.2 = 1).
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects, receives binary + text frames via onFrame', () => {
    const frames: Array<Buffer | string> = [];
    const client = new TunnelClient({
      url: 'wss://example/tunnel/x',
      token: 'tok',
      onFrame: (d) => frames.push(d),
      wsFactory: factory,
    });

    client.start();
    expect(client.getState()).toBe('connecting');
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('wss://example/tunnel/x');

    sockets[0].open();
    expect(client.getState()).toBe('connected');

    sockets[0].pushBinary(Buffer.from([1, 2, 3]));
    sockets[0].pushText('hello');

    expect(frames).toHaveLength(2);
    expect(Buffer.isBuffer(frames[0])).toBe(true);
    expect((frames[0] as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(frames[1]).toBe('hello');
  });

  it('send() forwards to the socket when connected; drops when not', () => {
    const client = new TunnelClient({
      url: 'wss://x',
      token: 't',
      onFrame: () => {},
      wsFactory: factory,
    });
    // Drop pre-start.
    client.send('pre');
    client.start();
    // Drop while connecting.
    client.send('mid');
    sockets[0].open();
    client.send(Buffer.from([9, 9]));
    client.send('after');

    expect(sockets[0].sent).toHaveLength(2);
    expect((sockets[0].sent[0] as Buffer).equals(Buffer.from([9, 9]))).toBe(
      true,
    );
    expect(sockets[0].sent[1]).toBe('after');
  });

  it('reconnects with backoff sequence 1s/2s/4s on close 1006', () => {
    vi.useFakeTimers();
    try {
      const client = new TunnelClient({
        url: 'wss://x',
        token: 't',
        onFrame: () => {},
        wsFactory: factory,
      });
      client.start();
      sockets[0].open();
      expect(client.getState()).toBe('connected');

      // First disconnect -> 1000ms backoff.
      sockets[0].closeFromServer(1006);
      expect(client.getState()).toBe('reconnecting');
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(999);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
      expect(client.getState()).toBe('connecting');

      // Second disconnect (without successful open) -> 2000ms.
      sockets[1].closeFromServer(1006);
      vi.advanceTimersByTime(1999);
      expect(sockets).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(3);

      // Third -> 4000ms.
      sockets[2].closeFromServer(1011);
      vi.advanceTimersByTime(3999);
      expect(sockets).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(4);

      // Successful connect on socket 4 resets attempts.
      sockets[3].open();
      expect(client.getState()).toBe('connected');
      sockets[3].closeFromServer(1006);
      // Back to 1000ms.
      vi.advanceTimersByTime(999);
      expect(sockets).toHaveLength(4);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(5);

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() prevents reconnects even after subsequent close 1006', () => {
    vi.useFakeTimers();
    try {
      const client = new TunnelClient({
        url: 'wss://x',
        token: 't',
        onFrame: () => {},
        wsFactory: factory,
      });
      client.start();
      sockets[0].open();
      expect(client.getState()).toBe('connected');

      client.stop();
      expect(client.getState()).toBe('stopped');
      // stop() called close() which fired our fake close handler — fine.
      // Even if the server-side then emits another 1006 somehow, no reconnect.
      sockets[0].closeFromServer(1006);
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
      expect(client.getState()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('computeBackoffMs caps at 30s and jitter range stays ±20%', () => {
    const client = new TunnelClient({
      url: 'wss://x',
      token: 't',
      onFrame: () => {},
      wsFactory: factory,
    });
    // With Math.random()=0.5 -> jitter factor = 1.
    expect(client.computeBackoffMs(0)).toBe(1000);
    expect(client.computeBackoffMs(1)).toBe(2000);
    expect(client.computeBackoffMs(2)).toBe(4000);
    expect(client.computeBackoffMs(3)).toBe(8000);
    expect(client.computeBackoffMs(4)).toBe(16000);
    expect(client.computeBackoffMs(5)).toBe(30000);
    expect(client.computeBackoffMs(99)).toBe(30000);

    // Jitter min (random=0 -> factor 0.8).
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(client.computeBackoffMs(0)).toBe(800);
    // Jitter max-ish (random≈1 -> factor 1.2), but cap honors 30s.
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    expect(client.computeBackoffMs(5)).toBeLessThanOrEqual(30_000);
  });
});
