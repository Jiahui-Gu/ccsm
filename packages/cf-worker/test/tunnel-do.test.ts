/**
 * TunnelDO unit tests.
 *
 * We don't boot wrangler / workerd here — pairing is a pure protocol
 * concern (wire two WebSocket-shaped objects together) and the workers
 * runtime adds boot cost + flake without exercising the logic we own.
 *
 * Strategy: stub `WebSocketPair`, a `WebSocket`-shaped object that supports
 * the Hibernation API attachment hooks, and a fake `DurableObjectState`
 * with `acceptWebSocket` / `getWebSockets`. We drive `TunnelDO.fetch(req)`
 * directly and dispatch socket events via the DO's class methods
 * (`webSocketMessage` / `webSocketClose` / `webSocketError`) the same way
 * the Cloudflare runtime does (Task #790, S3-E hibernation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeServerSocket {
  readonly side: 'server';
  accepted: boolean;          // legacy non-hibernating accept (ws/default 1011 path)
  hibernating: boolean;       // accepted via state.acceptWebSocket
  tags: string[];
  attachment: unknown;
  closed: boolean;
  closeCode?: number;
  closeReason?: string;
  sent: Array<unknown>;
  readyState: number;
  accept(): void;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface FakeClientSocket {
  readonly side: 'client';
}

function makeServerSocket(): FakeServerSocket {
  const sock: FakeServerSocket = {
    side: 'server',
    accepted: false,
    hibernating: false,
    tags: [],
    attachment: null,
    closed: false,
    sent: [],
    readyState: 1, // WebSocket.OPEN
    accept() {
      this.accepted = true;
    },
    send(data: unknown) {
      if (this.closed) throw new Error('socket closed');
      this.sent.push(data);
    },
    close(code?: number, reason?: string) {
      if (this.closed) return;
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      this.readyState = 3; // CLOSED
    },
    serializeAttachment(value: unknown) {
      this.attachment = value;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
  return sock;
}

const created: { client: FakeClientSocket; server: FakeServerSocket }[] = [];

class FakeWebSocketPair {
  '0': FakeClientSocket;
  '1': FakeServerSocket;
  constructor() {
    const client: FakeClientSocket = { side: 'client' };
    const server = makeServerSocket();
    this[0] = client;
    this[1] = server;
    created.push({ client, server });
  }
}

// Workers runtime allows `new Response(null, { status: 101, webSocket })`
// for ws upgrades; Node's undici Response rejects status < 200. Wrap to
// allow 101 only in tests so we can drive TunnelDO.fetch directly.
const NodeResponse = globalThis.Response;
class WorkersResponse {
  status: number;
  body: unknown;
  webSocket?: unknown;
  constructor(body: unknown, init?: { status?: number; webSocket?: unknown }) {
    if (init && typeof init.status === 'number' && init.status === 101) {
      this.status = 101;
      this.body = body;
      this.webSocket = init.webSocket;
      return;
    }
    // Fall through to real Response for non-upgrade paths so status/body
    // semantics match production for those branches.
    const real = new NodeResponse(body as BodyInit | null, init);
    return real as unknown as WorkersResponse;
  }
}

beforeEach(() => {
  created.length = 0;
  // @ts-expect-error — install workers-runtime globals for the unit test.
  globalThis.WebSocketPair = FakeWebSocketPair;
  // @ts-expect-error — patch Response to permit status 101 upgrades.
  globalThis.Response = WorkersResponse;
});

afterEach(() => {
  // @ts-expect-error — clean up to avoid leaking globals across files.
  delete globalThis.WebSocketPair;
  globalThis.Response = NodeResponse;
  vi.restoreAllMocks();
});

async function loadDO() {
  const mod = await import('../src/tunnel-do.js');
  return mod.TunnelDO;
}

function makeReq(path: string, protocol?: string): Request {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (protocol !== undefined) {
    headers['Sec-WebSocket-Protocol'] = protocol;
  }
  return new Request(`https://example.test${path}`, {
    headers,
  });
}

/** Browser /ws/default request with sid + lastSeq query params (Task #793). */
function makeBrowserWsReq(opts: { sid?: string; lastSeq?: number; protocol?: string }): Request {
  const params: string[] = [];
  if (opts.sid !== undefined) params.push(`sid=${encodeURIComponent(opts.sid)}`);
  if (opts.lastSeq !== undefined) params.push(`lastSeq=${opts.lastSeq}`);
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return makeReq(`/ws/default${qs}`, opts.protocol);
}

const BROWSER_PROTO = 'ccsm.test-token-xyz';

/**
 * Fake DurableObjectState that implements the WebSocket Hibernation surface
 * we use (`acceptWebSocket(ws, tags)` + `getWebSockets(tag?)`). The runtime's
 * real implementation also persists the socket across DO eviction; in the
 * unit test we only care that `getWebSockets(tag)` returns sockets that were
 * registered and have not been .close()d yet.
 */
function makeState(): DurableObjectState {
  const tracked: Array<{ ws: FakeServerSocket; tags: string[] }> = [];
  const state = {
    acceptWebSocket(ws: FakeServerSocket, tags?: string[]) {
      ws.hibernating = true;
      ws.tags = tags ?? [];
      tracked.push({ ws, tags: tags ?? [] });
    },
    getWebSockets(tag?: string): FakeServerSocket[] {
      return tracked
        .filter((t) => !t.ws.closed && (tag === undefined || t.tags.includes(tag)))
        .map((t) => t.ws);
    },
  };
  return state as unknown as DurableObjectState;
}

const fakeEnv = {} as { TUNNEL: DurableObjectNamespace };

/**
 * Helper to dispatch a hibernation message event through the DO.
 * Runtime calls `instance.webSocketMessage(ws, data)`; we mirror that.
 */
function emitMessage(
  inst: { webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void },
  ws: FakeServerSocket,
  data: string | ArrayBuffer,
): void {
  inst.webSocketMessage(ws as unknown as WebSocket, data);
}

function emitClose(
  inst: { webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void },
  ws: FakeServerSocket,
): void {
  ws.readyState = 3; // CLOSED — getDaemonSocket / getBrowserSocket filter on this
  inst.webSocketClose(ws as unknown as WebSocket, 1006, '', false);
  ws.closed = true;
}

function emitError(
  inst: { webSocketError(ws: WebSocket, err: unknown): void },
  ws: FakeServerSocket,
): void {
  inst.webSocketError(ws as unknown as WebSocket, new Error('test'));
}

describe('TunnelDO', () => {
  it('rejects non-websocket requests with 426', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    const res = await inst.fetch(
      new Request('https://example.test/tunnel/default'),
    );
    expect(res.status).toBe(426);
  });

  it('pairs daemon then browser; daemon -> browser forwards text + binary', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);

    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    expect(daemon.hibernating).toBe(true);
    expect(daemon.tags).toEqual(['daemon']);

    await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    const browser = created[1].server;
    expect(browser.hibernating).toBe(true);
    // Task #105 (R-41): browser ws is now tagged with both 'browser' and
    // 'browser-sid:<sid>' so the DO can recover per-sid.
    expect(browser.tags).toEqual(['browser', 'browser-sid:s']);
    expect(browser.closed).toBe(false);

    emitMessage(inst, daemon, 'hello');
    // Task #105 (R-41): daemon→browser binary is now sid-enveloped on the
    // wire. DO strips the envelope before delivering to the browser ws, so
    // the browser still sees raw payload bytes.
    const env = new Uint8Array(1 + 1 + 3);
    env[0] = 1; env[1] = 's'.charCodeAt(0);
    env[2] = 1; env[3] = 2; env[4] = 3;
    emitMessage(inst, daemon, env.buffer.slice(env.byteOffset, env.byteOffset + env.byteLength) as ArrayBuffer);
    expect(browser.sent).toEqual(['hello', new Uint8Array([1, 2, 3])]);
  });

  it('forwards browser -> daemon (text + binary), preceded by hello frame', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    const daemon = created[0].server;
    const browser = created[1].server;

    // Task #782: DO injects a hello control frame as the first daemon-bound
    // payload before any browser->daemon raw forwarding. Task #793 adds sid +
    // lastSeq so the daemon can route into the right per-session PTY.
    expect(daemon.sent).toHaveLength(1);
    expect(JSON.parse(daemon.sent[0] as string)).toEqual({
      type: 'hello',
      token: 'test-token-xyz',
      sid: 's',
      lastSeq: 0,
    });

    emitMessage(inst, browser, 'ping');
    emitMessage(inst, browser, new Uint8Array([9, 9]) as unknown as ArrayBuffer);
    // Task #105 (R-41): browser→daemon binary is wrapped in a sid envelope
    // by the DO so the daemon can route into the right per-sid PTY when
    // multiple browser tabs share one tunnel ws. Envelope: [sidLen, ...sid, ...payload].
    expect(daemon.sent.slice(1)).toEqual([
      'ping',
      new Uint8Array([1, 's'.charCodeAt(0), 9, 9]),
    ]);
  });

  it('extracts browserToken from Sec-WebSocket-Protocol header', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s', 'ccsm.abc-987'));
    expect(inst.getBrowserTokenForTest()).toBe('abc-987');
  });

  it('echoes Sec-WebSocket-Protocol on the 101 response so browser accepts handshake', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const res = await inst.fetch(makeReq('/ws/default?sid=s', 'ccsm.zzz'));
    expect(res.status).toBe(101);
    const headers = (res as unknown as { headers?: Headers | Record<string, string> }).headers;
    if (headers !== undefined) {
      const echoed =
        typeof (headers as Headers).get === 'function'
          ? (headers as Headers).get('Sec-WebSocket-Protocol')
          : (headers as Record<string, string>)['Sec-WebSocket-Protocol'];
      expect(echoed).toBe('ccsm.zzz');
    }
  });

  it('closes browser ws with 1008 when Sec-WebSocket-Protocol is missing', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const res = await inst.fetch(makeReq('/ws/default'));
    expect(res.status).toBe(101);
    const browser = created[1].server;
    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1008);
    expect(inst.getBrowserTokenForTest()).toBeNull();
  });

  it('closes browser ws with 1008 when no ccsm.* subprotocol is present', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s', 'other.subproto'));
    const browser = created[1].server;
    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1008);
  });

  it('closes browser ws with 1011 daemon offline when no daemon paired', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);

    const res = await inst.fetch(makeReq('/ws/default'));
    expect(res.status).toBe(101);
    const browser = created[0].server;
    expect(browser.accepted).toBe(true);
    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1011);
    expect(browser.closeReason).toBe('daemon offline');
  });

  it('daemon close triggers browser close 1006 and clears slots', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    const daemon = created[0].server;
    const browser = created[1].server;

    emitClose(inst, daemon);

    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1006);
    expect(browser.closeReason).toBe('daemon disconnected');

    // After daemon drop the next browser should hit "daemon offline" path
    // (slots cleared so a fresh /ws/default re-runs the no-daemon branch).
    const res = await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    expect(res.status).toBe(101);
    const browser2 = created[2].server;
    expect(browser2.closeCode).toBe(1011);
  });

  it('browser close leaves daemon alive; new browser can re-pair', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    const daemon = created[0].server;
    const browser = created[1].server;

    emitClose(inst, browser);
    expect(daemon.closed).toBe(false);

    await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    const browser2 = created[2].server;
    expect(browser2.hibernating).toBe(true);
    expect(browser2.closed).toBe(false);

    emitMessage(inst, daemon, 'after-rebind');
    expect(browser2.sent).toEqual(['after-rebind']);
  });

  it('daemon error closes browser with 1011 daemon error', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    const daemon = created[0].server;
    const browser = created[1].server;

    emitError(inst, daemon);

    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1011);
    expect(browser.closeReason).toBe('daemon error');
  });

  // ---- Task #793 (S3-G): hello frame carries sid + lastSeq --------------

  it('hello frame includes sid + lastSeq from the ws upgrade query', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(
      makeBrowserWsReq({ sid: 'sess-abc', lastSeq: 42, protocol: BROWSER_PROTO }),
    );
    const daemon = created[0].server;
    expect(daemon.sent).toHaveLength(1);
    expect(JSON.parse(daemon.sent[0] as string)).toEqual({
      type: 'hello',
      token: 'test-token-xyz',
      sid: 'sess-abc',
      lastSeq: 42,
    });
  });

  it('hello defaults lastSeq=0 when query param is omitted', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeBrowserWsReq({ sid: 'sess-1', protocol: BROWSER_PROTO }));
    const daemon = created[0].server;
    const hello = JSON.parse(daemon.sent[0] as string);
    expect(hello.sid).toBe('sess-1');
    expect(hello.lastSeq).toBe(0);
  });

  it('closes browser ws with 1008 when sid query param is missing', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    // Has token subprotocol, has paired daemon, but no sid → 1008.
    await inst.fetch(makeReq('/ws/default', BROWSER_PROTO));
    const browser = created[1].server;
    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1008);
    expect(browser.closeReason).toBe('missing sid');
    // Daemon must NOT have received a hello (no successful pairing).
    const daemon = created[0].server;
    expect(daemon.sent).toHaveLength(0);
  });

  it('closes browser ws with 1008 when sid query param is empty string', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=', BROWSER_PROTO));
    const browser = created[1].server;
    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1008);
  });

  it('ignores invalid lastSeq and falls back to 0', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s&lastSeq=NaN', BROWSER_PROTO));
    const daemon = created[0].server;
    const hello = JSON.parse(daemon.sent[0] as string);
    expect(hello.lastSeq).toBe(0);
    // Browser pairing succeeded.
    const browser = created[1].server;
    expect(browser.closed).toBe(false);
  });

  // ---- HTTP-over-tunnel (Task #787, S3-C) -------------------------------

  function makeHttpReq(path: string, method = 'GET', body?: string): Request {    return new Request(`https://example.test${path}`, {
      method,
      body,
    });
  }

  it('proxyHttp returns 503 when no daemon paired', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    const res = await inst.fetch(makeHttpReq('/api/sessions'));
    expect(res.status).toBe(503);
  });

  it('proxyHttp serializes http_req frame to daemon and resolves on http_res', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;

    const respPromise = inst.fetch(makeHttpReq('/api/sessions'));
    // Yield so the await req.arrayBuffer() and ws.send complete.
    await new Promise((r) => setTimeout(r, 0));

    expect(daemon.sent).toHaveLength(1);
    const frame = JSON.parse(daemon.sent[0] as string);
    expect(frame.type).toBe('http_req');
    expect(frame.method).toBe('GET');
    expect(frame.path).toBe('/api/sessions');
    expect(typeof frame.id).toBe('string');
    expect(frame.id.length).toBeGreaterThan(0);
    expect(inst.getPendingHttpCountForTest()).toBe(1);

    // Daemon sends back a control http_res frame.
    const bodyText = JSON.stringify({ ok: true });
    const body_b64 = btoa(bodyText);
    emitMessage(inst, daemon, JSON.stringify({
      type: 'http_res',
      id: frame.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body_b64,
    }));

    const res = await respPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(bodyText);
    expect(inst.getPendingHttpCountForTest()).toBe(0);
  });

  it('proxyHttp routes /token via the same path', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;

    const respPromise = inst.fetch(makeHttpReq('/token'));
    await new Promise((r) => setTimeout(r, 0));

    const frame = JSON.parse(daemon.sent[0] as string);
    expect(frame.path).toBe('/token');

    emitMessage(inst, daemon, JSON.stringify({
      type: 'http_res',
      id: frame.id,
      status: 200,
      headers: {},
      body_b64: btoa('tok'),
    }));
    const res = await respPromise;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('tok');
  });

  it('http_res control frame is NOT forwarded as raw output to browser', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default?sid=s', BROWSER_PROTO));
    const daemon = created[0].server;
    const browser = created[1].server;

    // Start an http req so there's a pending entry for the http_res to land on.
    const respPromise = inst.fetch(makeHttpReq('/api/sessions'));
    await new Promise((r) => setTimeout(r, 0));
    const reqFrame = JSON.parse(daemon.sent.at(-1) as string);

    emitMessage(inst, daemon, JSON.stringify({
      type: 'http_res',
      id: reqFrame.id,
      status: 200,
      headers: {},
      body_b64: btoa('ok'),
    }));
    await respPromise;

    // Browser should never have received the http_res control frame.
    for (const sent of browser.sent) {
      if (typeof sent === 'string') {
        expect(sent.includes('"type":"http_res"')).toBe(false);
      }
    }
  });

  it('daemon close while http req pending rejects with 502', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;

    const respPromise = inst.fetch(makeHttpReq('/api/sessions'));
    await new Promise((r) => setTimeout(r, 0));
    expect(inst.getPendingHttpCountForTest()).toBe(1);

    emitClose(inst, daemon);
    const res = await respPromise;
    expect(res.status).toBe(502);
    expect(inst.getPendingHttpCountForTest()).toBe(0);
  });

  // Task #789, S3-D regression: the DO MUST be able to forward /api/* to a
  // daemon that has never seen a browser pairing (i.e. no /ws/default open
  // and therefore no hello frame emitted to the daemon yet). The pre-fix
  // bug closed the daemon ws on the first http_req (daemon hello-gate
  // rejected http_req as malformed hello), causing 502 reconnect-loops.
  it('proxyHttp succeeds without any browser /ws/default pairing', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    // Sanity: no browser ever connected, so DO emitted NO hello frame.
    expect(daemon.sent).toHaveLength(0);

    const respPromise = inst.fetch(makeHttpReq('/api/sessions'));
    await new Promise((r) => setTimeout(r, 0));

    // First daemon-bound payload is the http_req itself, not a hello.
    expect(daemon.sent).toHaveLength(1);
    const frame = JSON.parse(daemon.sent[0] as string);
    expect(frame.type).toBe('http_req');
    expect(frame.path).toBe('/api/sessions');

    emitMessage(inst, daemon, JSON.stringify({
      type: 'http_res',
      id: frame.id,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body_b64: btoa('[]'),
    }));
    const res = await respPromise;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[]');
  });

  // ---- Hibernation (Task #790, S3-E) ------------------------------------

  it('hibernate -> wake: daemon socket is recovered via state.getWebSockets and proxyHttp still works', async () => {
    // Models the production 503 bug: DO instance is evicted after idle,
    // a fresh instance is constructed for the next request, and it must
    // re-discover the live daemon ws via state.getWebSockets('daemon')
    // rather than rely on in-memory `this.sockets`.
    const TunnelDO = await loadDO();
    const state = makeState();

    // First instance: daemon dials in.
    const inst1 = new TunnelDO(state, fakeEnv);
    await inst1.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    expect(daemon.hibernating).toBe(true);

    // Simulate hibernation: drop the first JS instance entirely. The fake
    // state preserves the registered ws (the runtime would do the same via
    // the hibernation API), so a fresh instance can recover it.
    const inst2 = new TunnelDO(state, fakeEnv);

    // No in-memory daemon ref on the new instance, but proxyHttp must still
    // succeed because the state-tracked daemon ws is reachable.
    const respPromise = inst2.fetch(makeHttpReq('/api/sessions'));
    await new Promise((r) => setTimeout(r, 0));

    expect(daemon.sent).toHaveLength(1);
    const frame = JSON.parse(daemon.sent[0] as string);
    expect(frame.type).toBe('http_req');

    emitMessage(inst2, daemon, JSON.stringify({
      type: 'http_res',
      id: frame.id,
      status: 200,
      headers: {},
      body_b64: btoa('ok'),
    }));
    const res = await respPromise;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('hibernate -> wake: browser token is restored from ws.deserializeAttachment', async () => {
    const TunnelDO = await loadDO();
    const state = makeState();

    const inst1 = new TunnelDO(state, fakeEnv);
    await inst1.fetch(makeReq('/tunnel/default'));
    await inst1.fetch(makeReq('/ws/default?sid=s', 'ccsm.persisted-tok'));
    expect(inst1.getBrowserTokenForTest()).toBe('persisted-tok');

    // Fresh instance after hibernation — token must come from the socket's
    // serialized attachment, not from a member field.
    const inst2 = new TunnelDO(state, fakeEnv);
    expect(inst2.getBrowserTokenForTest()).toBe('persisted-tok');
  });

  // ---- Task #105 (R-41): multi-sid envelope routing ----------------------

  function envelope(sid: string, payload: number[]): ArrayBuffer {
    const sidBytes = new TextEncoder().encode(sid);
    const out = new Uint8Array(1 + sidBytes.length + payload.length);
    out[0] = sidBytes.length;
    out.set(sidBytes, 1);
    out.set(Uint8Array.from(payload), 1 + sidBytes.length);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }

  it('R-41: two browsers (different sids) each receive only their own daemon binary frames', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    await inst.fetch(makeReq('/ws/default?sid=alpha', 'ccsm.tok-a'));
    await inst.fetch(makeReq('/ws/default?sid=beta', 'ccsm.tok-b'));
    const browserA = created[1].server;
    const browserB = created[2].server;

    expect(browserA.tags).toEqual(['browser', 'browser-sid:alpha']);
    expect(browserB.tags).toEqual(['browser', 'browser-sid:beta']);

    // Daemon emits a sid-enveloped binary for alpha then for beta.
    emitMessage(inst, daemon, envelope('alpha', [10, 20, 30]));
    emitMessage(inst, daemon, envelope('beta', [40, 50]));

    // Each browser only sees its own payload (envelope stripped).
    expect(browserA.sent).toEqual([new Uint8Array([10, 20, 30])]);
    expect(browserB.sent).toEqual([new Uint8Array([40, 50])]);
  });

  it('R-41: browser->daemon binary is wrapped with sender browser sid', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    await inst.fetch(makeReq('/ws/default?sid=alpha', 'ccsm.tok-a'));
    await inst.fetch(makeReq('/ws/default?sid=beta', 'ccsm.tok-b'));
    const browserA = created[1].server;
    const browserB = created[2].server;

    // Skip the two hello frames (one per browser pairing).
    const helloCount = daemon.sent.length;

    emitMessage(inst, browserA, new Uint8Array([1, 2]) as unknown as ArrayBuffer);
    emitMessage(inst, browserB, new Uint8Array([3, 4, 5]) as unknown as ArrayBuffer);

    const fromA = daemon.sent[helloCount] as Uint8Array;
    const fromB = daemon.sent[helloCount + 1] as Uint8Array;
    // alpha = 5 utf8 bytes -> sidLen=5, sid='alpha', payload=[1,2]
    expect(Array.from(fromA)).toEqual([5, ...new TextEncoder().encode('alpha'), 1, 2]);
    // beta = 4 utf8 bytes
    expect(Array.from(fromB)).toEqual([4, ...new TextEncoder().encode('beta'), 3, 4, 5]);
  });

  it('R-41: daemon binary with unknown sid is dropped (no fan-out)', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    await inst.fetch(makeReq('/ws/default?sid=alpha', 'ccsm.tok-a'));
    const browserA = created[1].server;

    // Daemon sends envelope with sid that no browser has paired with.
    emitMessage(inst, daemon, envelope('ghost', [9, 9]));
    expect(browserA.sent).toEqual([]);
  });

  it('R-41: malformed envelope (sidLen=0) is dropped, no crash', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    await inst.fetch(makeReq('/ws/default?sid=alpha', 'ccsm.tok-a'));
    const browserA = created[1].server;

    const bad = new Uint8Array([0, 1, 2, 3]);
    emitMessage(inst, daemon, bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength) as ArrayBuffer);
    expect(browserA.sent).toEqual([]);
  });

  it('R-41: daemon close fans out close to ALL paired browsers', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(makeState(), fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    await inst.fetch(makeReq('/ws/default?sid=alpha', 'ccsm.tok-a'));
    await inst.fetch(makeReq('/ws/default?sid=beta', 'ccsm.tok-b'));
    const browserA = created[1].server;
    const browserB = created[2].server;

    emitClose(inst, daemon);

    expect(browserA.closed).toBe(true);
    expect(browserA.closeCode).toBe(1006);
    expect(browserB.closed).toBe(true);
    expect(browserB.closeCode).toBe(1006);
  });

  it('R-41: hibernate -> wake recovers per-sid browser routing', async () => {
    const TunnelDO = await loadDO();
    const state = makeState();
    const inst1 = new TunnelDO(state, fakeEnv);
    await inst1.fetch(makeReq('/tunnel/default'));
    await inst1.fetch(makeReq('/ws/default?sid=alpha', 'ccsm.tok-a'));
    await inst1.fetch(makeReq('/ws/default?sid=beta', 'ccsm.tok-b'));
    const daemon = created[0].server;
    const browserA = created[1].server;
    const browserB = created[2].server;

    // Drop the first instance. New instance must re-discover via tags.
    const inst2 = new TunnelDO(state, fakeEnv);

    emitMessage(inst2, daemon, envelope('alpha', [7]));
    emitMessage(inst2, daemon, envelope('beta', [8]));

    expect(browserA.sent).toEqual([new Uint8Array([7])]);
    expect(browserB.sent).toEqual([new Uint8Array([8])]);
  });
});
