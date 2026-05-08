/**
 * TunnelDO unit tests.
 *
 * We don't boot wrangler / workerd here — pairing is a pure protocol
 * concern (wire two WebSocket-shaped objects together) and the workers
 * runtime adds boot cost + flake without exercising the logic we own.
 *
 * Strategy: stub `WebSocketPair` and a minimal `WebSocket`-shaped object
 * with addEventListener/dispatchEvent/send/close/accept on globalThis,
 * then drive `TunnelDO.fetch(req)` directly. Real wire-level pairing
 * over a live worker is covered by S3-T8 e2e.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (ev: { data?: unknown; code?: number; reason?: string }) => void;

interface FakeServerSocket {
  readonly side: 'server';
  accepted: boolean;
  closed: boolean;
  closeCode?: number;
  closeReason?: string;
  sent: Array<unknown>;
  listeners: { message: Listener[]; close: Listener[]; error: Listener[] };
  accept(): void;
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message' | 'close' | 'error', cb: Listener): void;
  // Test helpers (drive the socket as if a peer wrote/closed):
  emitMessage(data: unknown): void;
  emitClose(): void;
  emitError(): void;
}

interface FakeClientSocket {
  readonly side: 'client';
}

function makeServerSocket(): FakeServerSocket {
  const sock: FakeServerSocket = {
    side: 'server',
    accepted: false,
    closed: false,
    sent: [],
    listeners: { message: [], close: [], error: [] },
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
    },
    addEventListener(type, cb) {
      this.listeners[type].push(cb);
    },
    emitMessage(data) {
      for (const cb of this.listeners.message) cb({ data });
    },
    emitClose() {
      for (const cb of this.listeners.close) cb({});
      this.closed = true;
    },
    emitError() {
      for (const cb of this.listeners.error) cb({});
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

function makeReq(path: string): Request {
  return new Request(`https://example.test${path}`, {
    headers: { Upgrade: 'websocket' },
  });
}

const fakeState = {} as DurableObjectState;
const fakeEnv = {} as { TUNNEL: DurableObjectNamespace };

describe('TunnelDO', () => {
  it('rejects non-websocket requests with 426', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(fakeState, fakeEnv);
    const res = await inst.fetch(
      new Request('https://example.test/tunnel/default'),
    );
    expect(res.status).toBe(426);
  });

  it('pairs daemon then browser; daemon -> browser forwards text + binary', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(fakeState, fakeEnv);

    await inst.fetch(makeReq('/tunnel/default'));
    const daemon = created[0].server;
    expect(daemon.accepted).toBe(true);

    await inst.fetch(makeReq('/ws/default'));
    const browser = created[1].server;
    expect(browser.accepted).toBe(true);
    expect(browser.closed).toBe(false);

    daemon.emitMessage('hello');
    daemon.emitMessage(new Uint8Array([1, 2, 3]));
    expect(browser.sent).toEqual(['hello', new Uint8Array([1, 2, 3])]);
  });

  it('forwards browser -> daemon (text + binary)', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(fakeState, fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default'));
    const daemon = created[0].server;
    const browser = created[1].server;

    browser.emitMessage('ping');
    browser.emitMessage(new Uint8Array([9, 9]));
    expect(daemon.sent).toEqual(['ping', new Uint8Array([9, 9])]);
  });

  it('closes browser ws with 1011 daemon offline when no daemon paired', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(fakeState, fakeEnv);

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
    const inst = new TunnelDO(fakeState, fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default'));
    const daemon = created[0].server;
    const browser = created[1].server;

    daemon.emitClose();

    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1006);
    expect(browser.closeReason).toBe('daemon disconnected');

    // After daemon drop the next browser should hit "daemon offline" path
    // (slots cleared so a fresh /ws/default re-runs the no-daemon branch).
    const res = await inst.fetch(makeReq('/ws/default'));
    expect(res.status).toBe(101);
    const browser2 = created[2].server;
    expect(browser2.closeCode).toBe(1011);
  });

  it('browser close leaves daemon alive; new browser can re-pair', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(fakeState, fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default'));
    const daemon = created[0].server;
    const browser = created[1].server;

    browser.emitClose();
    expect(daemon.closed).toBe(false);

    await inst.fetch(makeReq('/ws/default'));
    const browser2 = created[2].server;
    expect(browser2.accepted).toBe(true);
    expect(browser2.closed).toBe(false);

    daemon.emitMessage('after-rebind');
    expect(browser2.sent).toEqual(['after-rebind']);
  });

  it('daemon error closes browser with 1011 daemon error', async () => {
    const TunnelDO = await loadDO();
    const inst = new TunnelDO(fakeState, fakeEnv);
    await inst.fetch(makeReq('/tunnel/default'));
    await inst.fetch(makeReq('/ws/default'));
    const daemon = created[0].server;
    const browser = created[1].server;

    daemon.emitError();

    expect(browser.closed).toBe(true);
    expect(browser.closeCode).toBe(1011);
    expect(browser.closeReason).toBe('daemon error');
  });
});
