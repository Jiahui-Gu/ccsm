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
  let factory: Mock<(url: string, protocols?: string[]) => WsLike>;
  let sockets: FakeSocket[];

  beforeEach(() => {
    sockets = [];
    factory = vi.fn((url: string, _protocols?: string[]) => {
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

  it('connects, receives binary + text frames via onFrame (after hello)', () => {
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

    // Hello gate (Task #782): first text frame must be the hello envelope.
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok' }));
    expect(client.getBrowserToken()).toBe('tok');
    // Hello itself is NOT forwarded to onFrame.
    expect(frames).toHaveLength(0);

    sockets[0].pushBinary(Buffer.from([1, 2, 3]));
    sockets[0].pushText('hello');

    expect(frames).toHaveLength(2);
    expect(Buffer.isBuffer(frames[0])).toBe(true);
    expect((frames[0] as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(frames[1]).toBe('hello');
  });

  it('hello with bad token closes 1008 and drops frames', () => {
    const frames: Array<Buffer | string> = [];
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'expected-token',
      onFrame: (d) => frames.push(d),
      wsFactory: factory,
    });
    client.start();
    sockets[0].open();

    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'WRONG' }));

    expect(sockets[0].closedCalls).toHaveLength(1);
    expect(sockets[0].closedCalls[0].code).toBe(1008);
    expect(client.getBrowserToken()).toBeNull();
    expect(frames).toHaveLength(0);
  });

  it('binary frame before hello closes 1008', () => {
    const frames: Array<Buffer | string> = [];
    const client = new TunnelClient({
      url: 'wss://x',
      token: 't',
      onFrame: (d) => frames.push(d),
      wsFactory: factory,
    });
    client.start();
    sockets[0].open();

    sockets[0].pushBinary(Buffer.from([1, 2, 3]));

    expect(sockets[0].closedCalls).toHaveLength(1);
    expect(sockets[0].closedCalls[0].code).toBe(1008);
    expect(frames).toHaveLength(0);
  });

  it('malformed hello (non-JSON / wrong shape) closes 1008', () => {
    const client = new TunnelClient({
      url: 'wss://x',
      token: 't',
      onFrame: () => {},
      wsFactory: factory,
    });
    client.start();
    sockets[0].open();

    sockets[0].pushText('not-json');
    expect(sockets[0].closedCalls).toHaveLength(1);
    expect(sockets[0].closedCalls[0].code).toBe(1008);
  });

  it('hello with correct token sets browserToken and unblocks frames', () => {
    const frames: Array<Buffer | string> = [];
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'good',
      onFrame: (d) => frames.push(d),
      wsFactory: factory,
    });
    client.start();
    sockets[0].open();
    expect(client.getBrowserToken()).toBeNull();

    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'good' }));
    expect(client.getBrowserToken()).toBe('good');
    expect(sockets[0].closedCalls).toHaveLength(0);

    sockets[0].pushText('subsequent');
    expect(frames).toEqual(['subsequent']);
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

  // ---- HTTP-over-tunnel (Task #787, S3-C) -------------------------------

  it('handles inbound http_req: fetches loopback and replies http_res', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      daemonLoopbackPort: 12345,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();
    // Hello first.
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok' }));

    sockets[0].pushText(JSON.stringify({
      type: 'http_req',
      id: 'req-1',
      method: 'GET',
      path: '/api/sessions',
      headers: { authorization: 'Bearer tok' },
      body_b64: '',
    }));

    // Wait for fetch + send.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('http://127.0.0.1:12345/api/sessions');
    expect((calledInit as RequestInit).method).toBe('GET');
    expect(((calledInit as RequestInit).headers as Record<string, string>).authorization)
      .toBe('Bearer tok');

    // Should have replied with an http_res text frame.
    const sent = sockets[0].sent.find((s) =>
      typeof s === 'string' && s.includes('"type":"http_res"'),
    ) as string | undefined;
    expect(sent).toBeDefined();
    const resFrame = JSON.parse(sent as string);
    expect(resFrame.id).toBe('req-1');
    expect(resFrame.status).toBe(200);
    expect(resFrame.headers['content-type']).toBe('application/json');
    expect(Buffer.from(resFrame.body_b64, 'base64').toString('utf8'))
      .toBe(JSON.stringify({ ok: true }));
  });

  it('http_req with body_b64 forwards decoded bytes to loopback fetch', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      return new Response('', { status: 204 });
    });
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      daemonLoopbackPort: 4242,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok' }));

    const payload = JSON.stringify({ foo: 'bar' });
    sockets[0].pushText(JSON.stringify({
      type: 'http_req',
      id: 'req-2',
      method: 'POST',
      path: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      body_b64: Buffer.from(payload, 'utf8').toString('base64'),
    }));

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect((init.body as Buffer).toString('utf8')).toBe(payload);
  });

  it('http_req fetch failure → http_res status 502', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      daemonLoopbackPort: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok' }));

    sockets[0].pushText(JSON.stringify({
      type: 'http_req',
      id: 'req-3',
      method: 'GET',
      path: '/api/sessions',
      headers: {},
      body_b64: '',
    }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const sent = sockets[0].sent.find((s) =>
      typeof s === 'string' && s.includes('"type":"http_res"'),
    ) as string | undefined;
    expect(sent).toBeDefined();
    const resFrame = JSON.parse(sent as string);
    expect(resFrame.id).toBe('req-3');
    expect(resFrame.status).toBe(502);
  });

  it('http_req control frames are NOT forwarded to onFrame', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 204 }));
    const onFrame = vi.fn();
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame,
      wsFactory: factory,
      daemonLoopbackPort: 1234,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok' }));

    sockets[0].pushText(JSON.stringify({
      type: 'http_req',
      id: 'req-4',
      method: 'GET',
      path: '/api/sessions',
      headers: {},
      body_b64: '',
    }));
    // Plain non-control text still flows through onFrame.
    sockets[0].pushText('not-a-control-frame');

    await new Promise((r) => setTimeout(r, 0));

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0][0]).toBe('not-a-control-frame');
  });

  // ---- Task #789, S3-D: http_req allowed before hello ------------------

  it('http_req before hello is accepted (browser may not be paired)', async () => {
    // Reproduces the Task #789 bug: the DO forwards `/api/*` requests to the
    // daemon ws as http_req frames whether or not a browser is paired. The
    // pre-fix daemon hello-gate rejected http_req as a malformed hello and
    // closed 1008, causing the daemon to reconnect-loop and the browser to
    // see 502 from the DO's pendingHttp rejection path.
    const fetchImpl = vi.fn(async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const onFrame = vi.fn();
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame,
      wsFactory: factory,
      daemonLoopbackPort: 9999,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();
    expect(client.getBrowserToken()).toBeNull();

    // No hello yet — the DO sends http_req directly.
    sockets[0].pushText(JSON.stringify({
      type: 'http_req',
      id: 'pre-hello-1',
      method: 'GET',
      path: '/api/sessions',
      headers: {},
      body_b64: '',
    }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // No 1008 close.
    expect(sockets[0].closedCalls).toHaveLength(0);
    // helloSeen stays false — a later browser pairing still requires hello.
    expect(client.getBrowserToken()).toBeNull();
    // http_res sent back.
    const sent = sockets[0].sent.find((s) =>
      typeof s === 'string' && s.includes('"type":"http_res"'),
    ) as string | undefined;
    expect(sent).toBeDefined();
    const resFrame = JSON.parse(sent as string);
    expect(resFrame.id).toBe('pre-hello-1');
    expect(resFrame.status).toBe(200);
    // onFrame NOT called for control frames.
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('after pre-hello http_req, a subsequent browser hello still flips helloSeen', async () => {
    // Guard the invariant: handling http_req before hello must NOT silently
    // mark helloSeen=true (otherwise a fake browser could skip the token
    // check entirely by injecting an http_req as the first frame).
    const fetchImpl = vi.fn(async () => new Response('', { status: 204 }));
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'good-token',
      onFrame: () => {},
      wsFactory: factory,
      daemonLoopbackPort: 9999,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();

    sockets[0].pushText(JSON.stringify({
      type: 'http_req',
      id: 'p',
      method: 'GET',
      path: '/api/x',
      headers: {},
      body_b64: '',
    }));
    expect(client.getBrowserToken()).toBeNull();

    // Now a browser pairs; hello with bad token must still be rejected.
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'WRONG' }));
    expect(sockets[0].closedCalls).toHaveLength(1);
    expect(sockets[0].closedCalls[0].code).toBe(1008);
  });

  it('binary frame before hello still closes 1008 even with http mux enabled', async () => {
    // Raw passthrough channel must remain gated by hello.
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      daemonLoopbackPort: 9999,
      fetchImpl: (async () => new Response('', { status: 204 })) as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();
    sockets[0].pushBinary(Buffer.from([1, 2, 3]));
    expect(sockets[0].closedCalls).toHaveLength(1);
    expect(sockets[0].closedCalls[0].code).toBe(1008);
  });

  it('non-control non-hello text before hello still closes 1008', async () => {
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      daemonLoopbackPort: 9999,
      fetchImpl: (async () => new Response('', { status: 204 })) as unknown as typeof fetch,
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText('plain-text-not-json');
    expect(sockets[0].closedCalls).toHaveLength(1);
    expect(sockets[0].closedCalls[0].code).toBe(1008);
  });

  // ---- Task #793 (S3-G): hello-with-sid → onBrowserAttach --------------

  it('hello with sid+lastSeq invokes onBrowserAttach with parsed values', () => {
    const attachCalls: Array<{ sid: string; lastSeq: number }> = [];
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      onBrowserAttach: ({ sid, lastSeq }) => {
        attachCalls.push({ sid, lastSeq });
        return { onFrame: () => {}, onClose: () => {} };
      },
    });
    client.start();
    sockets[0].open();

    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'tok',
      sid: 'sess-abc',
      lastSeq: 17,
    }));

    expect(attachCalls).toEqual([{ sid: 'sess-abc', lastSeq: 17 }]);
    expect(client.getBrowserToken()).toBe('tok');
  });

  it('hello without sid does NOT invoke onBrowserAttach (legacy passthrough)', () => {
    const onBrowserAttach = vi.fn();
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      onBrowserAttach: onBrowserAttach as unknown as Parameters<typeof TunnelClient>[0]['onBrowserAttach'],
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok' }));
    expect(onBrowserAttach).not.toHaveBeenCalled();
  });

  it('post-hello binary frames (sid-enveloped) route to the matching attach handle, not onFrame', () => {
    // Task #105 (R-41): browser→daemon binary on the wire now carries a
    // sid envelope `[sidLen][sid utf8][payload]`. The daemon decodes the
    // header, looks up the attach handle for that sid, and forwards the
    // payload (envelope stripped). Frames whose sid never attached are
    // dropped with a warn log.
    const onFrame = vi.fn();
    const handleFrames: Buffer[] = [];
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame,
      wsFactory: factory,
      onBrowserAttach: () => ({
        onFrame: (data) => handleFrames.push(data),
        onClose: () => {},
      }),
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'tok',
      sid: 'sess',
      lastSeq: 0,
    }));

    // Build envelope: [sidLen=4]['s','e','s','s'][1,2,3]
    const env = Buffer.concat([
      Buffer.from([4]),
      Buffer.from('sess', 'utf8'),
      Buffer.from([1, 2, 3]),
    ]);
    sockets[0].pushBinary(env);
    expect(handleFrames).toHaveLength(1);
    expect(handleFrames[0].equals(Buffer.from([1, 2, 3]))).toBe(true);
    // onFrame NOT called when attach handle owns binary routing.
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('attach handle.send() wraps payload in sid envelope before pushing through tunnel ws', () => {
    // Task #105 (R-41): daemon→browser binary is wrapped in a sid envelope
    // so the DO can route to the right per-sid browser ws. The wrap
    // happens at the BrowserAttachInfo.send seam so registry callers don't
    // have to know envelope exists.
    let sendBack: ((data: Uint8Array | Buffer) => void) | null = null;
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      onBrowserAttach: ({ send }) => {
        sendBack = send;
        return { onFrame: () => {}, onClose: () => {} };
      },
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'tok',
      sid: 'sess',
      lastSeq: 0,
    }));

    expect(sendBack).not.toBeNull();
    (sendBack as unknown as (data: Uint8Array) => void)(new Uint8Array([7, 8, 9]));
    // Tunnel ws.send should have received an envelope: [4]['s','e','s','s'][7,8,9]
    expect(sockets[0].sent).toHaveLength(1);
    const sent = sockets[0].sent[0] as Buffer;
    expect(Buffer.isBuffer(sent)).toBe(true);
    const expected = Buffer.concat([
      Buffer.from([4]),
      Buffer.from('sess', 'utf8'),
      Buffer.from([7, 8, 9]),
    ]);
    expect(sent.equals(expected)).toBe(true);
  });

  it('socket close after attach fires handle.onClose exactly once', () => {
    const onClose = vi.fn();
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      onBrowserAttach: () => ({ onFrame: () => {}, onClose }),
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'tok',
      sid: 'sess',
      lastSeq: 0,
    }));

    sockets[0].closeFromServer(1006);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ---- Task #105 (R-41): wave-2 multi-sid keep-both ---------------------

  it('second hello with new sid keeps the old handle attached and adds the new one', () => {
    // Wave-2 (R-41): one tunnel ws fans out N concurrent browser tabs to
    // the same daemon. Each unique sid hello adds a NEW attach handle; the
    // prior sid's handle is NOT torn down (that was the wave-1 R-27
    // behaviour). Same-sid hello stays idempotent.
    const attachCalls: Array<{ sid: string; lastSeq: number }> = [];
    const closeCalls: string[] = [];
    let nextHandleId = 0;
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      onBrowserAttach: ({ sid, lastSeq }) => {
        attachCalls.push({ sid, lastSeq });
        const id = `handle-${nextHandleId++}-for-${sid}`;
        return {
          onFrame: () => {},
          onClose: () => {
            closeCalls.push(id);
          },
        };
      },
    });
    client.start();
    sockets[0].open();

    // First hello: sid=A.
    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'tok',
      sid: 'sess-A',
      lastSeq: 0,
    }));
    expect(attachCalls).toEqual([{ sid: 'sess-A', lastSeq: 0 }]);
    expect(closeCalls).toEqual([]);
    expect(sockets[0].closedCalls).toHaveLength(0);

    // Second hello: sid=B on the SAME ws → keep-both, NO tear-down.
    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'tok',
      sid: 'sess-B',
      lastSeq: 5,
    }));
    expect(attachCalls).toEqual([
      { sid: 'sess-A', lastSeq: 0 },
      { sid: 'sess-B', lastSeq: 5 },
    ]);
    // R-41 critical: old handle MUST NOT be closed.
    expect(closeCalls).toEqual([]);
    expect(sockets[0].closedCalls).toHaveLength(0);

    // Third hello: same sid=B → idempotent; no new attach, no close.
    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'tok',
      sid: 'sess-B',
      lastSeq: 9,
    }));
    expect(attachCalls).toEqual([
      { sid: 'sess-A', lastSeq: 0 },
      { sid: 'sess-B', lastSeq: 5 },
    ]);
    expect(closeCalls).toEqual([]);

    // Tunnel ws close fires onClose for ALL active handles.
    sockets[0].closeFromServer(1006);
    expect(closeCalls.sort()).toEqual([
      'handle-0-for-sess-A',
      'handle-1-for-sess-B',
    ].sort());
  });

  it('post-hello multi-sid: sid-enveloped binary frames route to the right handle', () => {
    // R-41 multi-sid fan-out: with two attach handles bound, binary frames
    // on the wire MUST be sid-enveloped and route to whichever handle owns
    // that sid. Frames whose sid never attached are dropped (no fall-through
    // to the default onFrame, which would short-circuit the routing layer).
    const handleAFrames: Buffer[] = [];
    const handleBFrames: Buffer[] = [];
    const onFrame = vi.fn();
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'tok',
      onFrame,
      wsFactory: factory,
      onBrowserAttach: ({ sid }) => {
        const target = sid === 'sess-A' ? handleAFrames : handleBFrames;
        return {
          onFrame: (data) => target.push(data),
          onClose: () => {},
        };
      },
    });
    client.start();
    sockets[0].open();

    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok', sid: 'sess-A', lastSeq: 0 }));
    sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'tok', sid: 'sess-B', lastSeq: 0 }));

    function envelope(sid: string, payload: number[]): Buffer {
      return Buffer.concat([
        Buffer.from([Buffer.byteLength(sid, 'utf8')]),
        Buffer.from(sid, 'utf8'),
        Buffer.from(payload),
      ]);
    }
    sockets[0].pushBinary(envelope('sess-A', [0xa1]));
    sockets[0].pushBinary(envelope('sess-B', [0xb1]));
    sockets[0].pushBinary(envelope('sess-B', [0xb2]));
    // Unknown sid → dropped.
    sockets[0].pushBinary(envelope('ghost', [0xff]));
    // Malformed envelope (sidLen=0) → dropped.
    sockets[0].pushBinary(Buffer.from([0, 1, 2]));

    expect(handleAFrames.map((b) => Array.from(b))).toEqual([[0xa1]]);
    expect(handleBFrames.map((b) => Array.from(b))).toEqual([[0xb1], [0xb2]]);
    // onFrame is bypassed entirely once any attach handle is bound.
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('re-pair hello with bad token closes 1008', () => {
    // Token is re-checked on EVERY hello. A spoofed re-pair must still hit
    // the 1008 path. (Once the ws is closed, the close handler tears the
    // old attach down via onClose — that's covered by the close-fires-once
    // test above.)
    const client = new TunnelClient({
      url: 'wss://x',
      token: 'good',
      onFrame: () => {},
      wsFactory: factory,
      onBrowserAttach: () => ({ onFrame: () => {}, onClose: () => {} }),
    });
    client.start();
    sockets[0].open();
    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'good',
      sid: 'sess-A',
      lastSeq: 0,
    }));
    expect(sockets[0].closedCalls).toHaveLength(0);

    sockets[0].pushText(JSON.stringify({
      type: 'hello',
      token: 'WRONG',
      sid: 'sess-B',
      lastSeq: 0,
    }));
    expect(sockets[0].closedCalls).toHaveLength(1);
    expect(sockets[0].closedCalls[0].code).toBe(1008);
  });

  // ---- Task #133 (S4-T6): CCSM_TRUST_TUNNEL identity acceptance ---------

  describe('trust-tunnel mode (CCSM_TRUST_TUNNEL=1)', () => {
    const ORIGINAL_ENV = process.env.CCSM_TRUST_TUNNEL;

    beforeEach(() => {
      process.env.CCSM_TRUST_TUNNEL = '1';
    });

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) {
        delete process.env.CCSM_TRUST_TUNNEL;
      } else {
        process.env.CCSM_TRUST_TUNNEL = ORIGINAL_ENV;
      }
    });

    it('accepts hello with identity and no token', () => {
      const attachCalls: Array<{ sid: string; identity?: { login: string; github_id: string } }> = [];
      const client = new TunnelClient({
        url: 'wss://x',
        // daemon-side token kept for legacy callers but not consulted in trust mode.
        token: 'ignored-in-trust-mode',
        onFrame: () => {},
        wsFactory: factory,
        onBrowserAttach: ({ sid, identity }) => {
          attachCalls.push({ sid, identity });
          return { onFrame: () => {}, onClose: () => {} };
        },
      });
      client.start();
      sockets[0].open();

      sockets[0].pushText(JSON.stringify({
        type: 'hello',
        sid: 'sess-A',
        lastSeq: 0,
        identity: { login: 'octocat', github_id: '583231' },
      }));

      expect(sockets[0].closedCalls).toHaveLength(0);
      expect(attachCalls).toEqual([
        { sid: 'sess-A', identity: { login: 'octocat', github_id: '583231' } },
      ]);
      expect(client.getBrowserIdentity('sess-A')).toEqual({
        login: 'octocat',
        github_id: '583231',
      });
      // Legacy browserToken stays null when no token rode along.
      expect(client.getBrowserToken()).toBeNull();
    });

    it('rejects hello with neither token nor identity (1008)', () => {
      const client = new TunnelClient({
        url: 'wss://x',
        token: 't',
        onFrame: () => {},
        wsFactory: factory,
      });
      client.start();
      sockets[0].open();

      // Note: parseHello rejects {type:'hello'} with no token+no identity
      // outright, so the daemon falls into the "malformed hello frame"
      // close path. Either way the contract is the same: ws is closed 1008.
      sockets[0].pushText(JSON.stringify({ type: 'hello', sid: 'sess-A' }));

      expect(sockets[0].closedCalls).toHaveLength(1);
      expect(sockets[0].closedCalls[0].code).toBe(1008);
    });
  });

  it('legacy mode (CCSM_TRUST_TUNNEL unset): hello with token + no identity is accepted (back-compat)', () => {
    const prior = process.env.CCSM_TRUST_TUNNEL;
    delete process.env.CCSM_TRUST_TUNNEL;
    try {
      const frames: Array<Buffer | string> = [];
      const client = new TunnelClient({
        url: 'wss://x',
        token: 'good',
        onFrame: (d) => frames.push(d),
        wsFactory: factory,
      });
      client.start();
      sockets[0].open();
      sockets[0].pushText(JSON.stringify({ type: 'hello', token: 'good' }));
      expect(sockets[0].closedCalls).toHaveLength(0);
      expect(client.getBrowserToken()).toBe('good');

      sockets[0].pushText('after');
      expect(frames).toEqual(['after']);
    } finally {
      if (prior !== undefined) process.env.CCSM_TRUST_TUNNEL = prior;
    }
  });

  it('legacy mode: hello with identity but no token is rejected (1008) — env opt-in required', () => {
    const prior = process.env.CCSM_TRUST_TUNNEL;
    delete process.env.CCSM_TRUST_TUNNEL;
    try {
      const client = new TunnelClient({
        url: 'wss://x',
        token: 'good',
        onFrame: () => {},
        wsFactory: factory,
      });
      client.start();
      sockets[0].open();

      sockets[0].pushText(JSON.stringify({
        type: 'hello',
        sid: 'sess-A',
        identity: { login: 'octocat', github_id: '583231' },
      }));

      expect(sockets[0].closedCalls).toHaveLength(1);
      expect(sockets[0].closedCalls[0].code).toBe(1008);
    } finally {
      if (prior !== undefined) process.env.CCSM_TRUST_TUNNEL = prior;
    }
  });

  // ---- S4-T8 (Task #141) ws subprotocol negotiation -------------------
  it('passes the configured subprotocols through to the ws factory', () => {
    const client = new TunnelClient({
      url: 'wss://example/tunnel/x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      subprotocols: ['ccsm.eyJhbGciOi.payload.sig'],
    });
    client.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      'wss://example/tunnel/x',
      ['ccsm.eyJhbGciOi.payload.sig'],
    );
  });

  it('passes undefined subprotocols (legacy) when not configured', () => {
    const client = new TunnelClient({
      url: 'wss://example/tunnel/x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
    });
    client.start();
    expect(factory).toHaveBeenCalledWith('wss://example/tunnel/x', undefined);
  });

  it('treats an empty subprotocols array as legacy (passes undefined)', () => {
    const client = new TunnelClient({
      url: 'wss://example/tunnel/x',
      token: 'tok',
      onFrame: () => {},
      wsFactory: factory,
      subprotocols: [],
    });
    client.start();
    expect(factory).toHaveBeenCalledWith('wss://example/tunnel/x', undefined);
  });
});
