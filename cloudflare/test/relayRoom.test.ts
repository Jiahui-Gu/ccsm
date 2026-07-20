/* global CloseEvent, DurableObjectStub, MessageEvent, Request, WebSocket */

import { env as testEnv, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  DESKTOP_ABSENT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_RELAY_FRAME_BYTES,
} from '../src/limits';
import { type RelayAttachment, RelayRoom } from '../src/relayRoom';
import type { Env } from '../src/worker';

const env = testEnv as unknown as Env;

function room() {
  return env.RELAY.getByName(crypto.randomUUID());
}

async function connect(
  stub: DurableObjectStub<RelayRoom>,
  role: RelayAttachment['role'],
): Promise<WebSocket> {
  const response = await stub.fetch(
    new Request(`https://relay.example/?role=${role}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );
  const ws = response.webSocket;
  if (!ws) throw new Error('RelayRoom did not return a WebSocket');
  ws.accept();
  return ws;
}

function nextEvent<T extends Event>(
  target: WebSocket,
  type: 'close' | 'message',
): Promise<T> {
  return new Promise((resolve) => {
    target.addEventListener(type, (event) => resolve(event as T), { once: true });
  });
}

describe('RelayRoom', () => {
  it('replaces the existing socket for the same role', async () => {
    const stub = room();
    const previous = await connect(stub, 'desktop');
    const closed = nextEvent<CloseEvent>(previous, 'close');

    await connect(stub, 'desktop');

    await expect(closed).resolves.toMatchObject({ code: 4001, reason: 'replaced' });
  });

  it('forwards frames and authenticates only after a handshake proof', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');
    const helloReceived = nextEvent<MessageEvent>(phone, 'message');

    desktop.send('{"type":"handshake.hello"}');

    await expect(helloReceived).resolves.toMatchObject({
      data: '{"type":"handshake.hello"}',
    });
    await runInDurableObject(stub, (_instance, state) => {
      const [server] = state.getWebSockets('desktop');
      expect(
        (server?.deserializeAttachment() as RelayAttachment).authenticated,
      ).toBe(false);
    });

    const proofReceived = nextEvent<MessageEvent>(phone, 'message');
    desktop.send('{"type":"handshake.proof"}');
    await proofReceived;
    await runInDurableObject(stub, (_instance, state) => {
      const [server] = state.getWebSockets('desktop');
      expect(
        (server?.deserializeAttachment() as RelayAttachment).authenticated,
      ).toBe(true);
    });
  });

  it('closes an oversized sender without forwarding the frame', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');
    const closed = nextEvent<CloseEvent>(desktop, 'close');
    let forwarded = false;
    phone.addEventListener('message', () => {
      forwarded = true;
    });

    desktop.send(new ArrayBuffer(MAX_RELAY_FRAME_BYTES + 1));

    await expect(closed).resolves.toMatchObject({
      code: 1009,
      reason: 'frame_too_large',
    });
    expect(forwarded).toBe(false);
  });

  it('expires unauthenticated sockets after ten seconds', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const closed = nextEvent<CloseEvent>(desktop, 'close');

    await runInDurableObject(stub, async (instance, state) => {
      const [server] = state.getWebSockets('desktop');
      server?.serializeAttachment({
        authenticated: false,
        connectedAt: Date.now() - HANDSHAKE_TIMEOUT_MS - 1,
        role: 'desktop',
      } satisfies RelayAttachment);
      await instance.alarm();
    });

    await expect(closed).resolves.toMatchObject({
      code: 4003,
      reason: 'handshake_timeout',
    });
  });

  it('cleans up a phone left idle without a desktop', async () => {
    const stub = room();
    const phone = await connect(stub, 'phone');
    const closed = nextEvent<CloseEvent>(phone, 'close');

    await runInDurableObject(stub, async (instance, state) => {
      const [server] = state.getWebSockets('phone');
      server?.serializeAttachment({
        authenticated: true,
        connectedAt: Date.now() - DESKTOP_ABSENT_TIMEOUT_MS - 1,
        role: 'phone',
      } satisfies RelayAttachment);
      await instance.alarm();
    });

    await expect(closed).resolves.toMatchObject({
      code: 4004,
      reason: 'desktop_absent',
    });
  });

  it('propagates a socket close to the peer', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');
    const phoneClosed = nextEvent<CloseEvent>(phone, 'close');

    desktop.close(1000, 'finished');

    await expect(phoneClosed).resolves.toMatchObject({
      code: 1000,
      reason: 'finished',
    });
  });
});
