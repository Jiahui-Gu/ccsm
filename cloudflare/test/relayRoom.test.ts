/* global CloseEvent, DurableObjectStub, MessageEvent, Request, Response, WebSocket */

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
  const response = await connectResponse(stub, role);
  const ws = response.webSocket;
  if (!ws) throw new Error('RelayRoom did not return a WebSocket');
  ws.accept();
  return ws;
}

async function connectResponse(
  stub: DurableObjectStub<RelayRoom>,
  role: RelayAttachment['role'],
): Promise<Response> {
  return stub.fetch(
    new Request(`https://relay.example/?role=${role}`, {
      headers: { Upgrade: 'websocket' },
    }),
  );
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
  it('rejects a reconnect while the role is active and preserves close propagation', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');

    const replacement = await connectResponse(stub, 'desktop');

    expect(replacement.status).toBe(409);
    expect(replacement.webSocket).toBeNull();

    const phoneClosed = nextEvent<CloseEvent>(phone, 'close');
    desktop.close(1000, 'finished');
    await expect(phoneClosed).resolves.toMatchObject({
      code: 1000,
      reason: 'finished',
    });
  });

  it('does not let an unverified frame evict the active socket for a role', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');
    const proofReceived = nextEvent<MessageEvent>(phone, 'message');

    desktop.send('{"type":"handshake.proof"}');
    await proofReceived;
    await runInDurableObject(stub, (_instance, state) => {
      const [server] = state.getWebSockets('desktop');
      const attachment = server?.deserializeAttachment() as RelayAttachment;
      expect(attachment.handshakeDeadline).not.toBeNull();
      expect(attachment).not.toHaveProperty('authenticated');
    });

    const takeover = await connectResponse(stub, 'desktop');
    expect(takeover.status).toBe(409);
    expect(takeover.webSocket).toBeNull();

    const received = nextEvent<MessageEvent>(phone, 'message');
    desktop.send('incumbent');
    await expect(received).resolves.toMatchObject({ data: 'incumbent' });
  });

  it('ignores a stale close callback after a newer socket takes the role', async () => {
    const stub = room();
    const previous = await connect(stub, 'desktop');
    let previousServer: WebSocket | undefined;
    await runInDurableObject(stub, (_instance, state) => {
      [previousServer] = state.getWebSockets('desktop');
    });
    const previousClosed = nextEvent<CloseEvent>(previous, 'close');
    await runInDurableObject(stub, () => {
      previousServer?.close(1000, 'reconnect');
    });
    await previousClosed;

    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');
    await runInDurableObject(stub, async (instance) => {
      if (!previousServer) throw new Error('Missing previous server socket');
      await instance.webSocketClose(previousServer, 1000, 'stale', true);
    });

    const received = nextEvent<MessageEvent>(phone, 'message');
    desktop.send('new connection');
    await expect(received).resolves.toMatchObject({ data: 'new connection' });
  });

  it('allows a same-role retry after the incumbent transport closes', async () => {
    const stub = room();
    const previous = await connect(stub, 'desktop');
    const closed = nextEvent<CloseEvent>(previous, 'close');

    await runInDurableObject(stub, (_instance, state) => {
      state.getWebSockets('desktop')[0]?.close(1000, 'reconnect');
    });
    await closed;
    const replacement = await connectResponse(stub, 'desktop');

    expect(replacement.status).toBe(101);
  });

  it('migrates hibernated attachments without trusting legacy authentication state', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const closed = nextEvent<CloseEvent>(desktop, 'close');
    await runInDurableObject(stub, (_instance, state) => {
      state.getWebSockets('desktop')[0]?.serializeAttachment({
        authenticated: true,
        connectedAt: Date.now() - HANDSHAKE_TIMEOUT_MS - 1,
        role: 'desktop',
      });
    });

    const candidate = await connectResponse(stub, 'desktop');

    expect(candidate.status).toBe(409);
    await expect(closed).resolves.toMatchObject({
      code: 4003,
      reason: 'handshake_timeout',
    });
  });

  it('clears the handshake timer only after both peers confirm authentication', async () => {
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
      const attachment = server?.deserializeAttachment() as RelayAttachment;
      expect(attachment.hasForwardedFrame).toBe(true);
      expect(attachment.handshakeDeadline).not.toBeNull();
      expect(attachment).not.toHaveProperty('authenticated');
    });

    const proofReceived = nextEvent<MessageEvent>(desktop, 'message');
    phone.send('{"type":"handshake.proof"}');
    await proofReceived;
    await runInDurableObject(stub, (_instance, state) => {
      for (const server of state.getWebSockets()) {
        const attachment = server.deserializeAttachment() as RelayAttachment;
        expect(attachment.handshakeDeadline).not.toBeNull();
        expect(attachment).not.toHaveProperty('authenticated');
      }
    });

    desktop.send('{"type":"relay.authenticated"}');
    await runInDurableObject(stub, (_instance, state) => {
      const [desktopServer] = state.getWebSockets('desktop');
      const [phoneServer] = state.getWebSockets('phone');
      expect((desktopServer?.deserializeAttachment() as RelayAttachment).handshakeDeadline)
        .not.toBeNull();
      expect((phoneServer?.deserializeAttachment() as RelayAttachment).handshakeDeadline)
        .not.toBeNull();
    });

    phone.send('{"type":"relay.authenticated"}');
    await runInDurableObject(stub, (_instance, state) => {
      for (const server of state.getWebSockets()) {
        expect(
          (server.deserializeAttachment() as RelayAttachment).handshakeDeadline,
        ).toBeNull();
      }
    });
  });

  it('does not reuse authentication confirmed for an earlier peer connection', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');
    desktop.send('{"type":"relay.authenticated"}');
    phone.send('{"type":"relay.authenticated"}');
    await runInDurableObject(stub, (_instance, state) => {
      const [phoneServer] = state.getWebSockets('phone');
      const attachment = phoneServer?.deserializeAttachment() as RelayAttachment;
      phoneServer?.serializeAttachment({
        ...attachment,
        connectionId: crypto.randomUUID(),
        authenticationConfirmed: false,
        authenticatedPeerConnectionId: null,
        handshakeDeadline: Date.now() + HANDSHAKE_TIMEOUT_MS,
      } satisfies RelayAttachment);
    });

    phone.send('{"type":"relay.authenticated"}');

    await runInDurableObject(stub, (_instance, state) => {
      for (const server of state.getWebSockets()) {
        expect(
          (server.deserializeAttachment() as RelayAttachment).handshakeDeadline,
        ).not.toBeNull();
      }
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

  it('expires sockets without bidirectional handshake progress after ten seconds', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const closed = nextEvent<CloseEvent>(desktop, 'close');

    await runInDurableObject(stub, async (instance, state) => {
      const [server] = state.getWebSockets('desktop');
      server?.serializeAttachment({
        connectionId: crypto.randomUUID(),
        connectedAt: Date.now() - HANDSHAKE_TIMEOUT_MS - 1,
        handshakeDeadline: Date.now() - 1,
        hasForwardedFrame: false,
        authenticationConfirmed: false,
        authenticatedPeerConnectionId: null,
        role: 'desktop',
      } satisfies RelayAttachment);
      await instance.alarm();
    });

    await expect(closed).resolves.toMatchObject({
      code: 4003,
      reason: 'handshake_timeout',
    });
  });

  it('enforces an expired handshake deadline before forwarding a late frame', async () => {
    const stub = room();
    const desktop = await connect(stub, 'desktop');
    const phone = await connect(stub, 'phone');
    const closed = nextEvent<CloseEvent>(desktop, 'close');
    let forwarded = false;
    phone.addEventListener('message', () => {
      forwarded = true;
    });
    await runInDurableObject(stub, (_instance, state) => {
      const server = state.getWebSockets('desktop')[0];
      const attachment = server?.deserializeAttachment() as RelayAttachment;
      server?.serializeAttachment({
        ...attachment,
        handshakeDeadline: Date.now() - 1,
      } satisfies RelayAttachment);
    });

    desktop.send('late');

    await expect(closed).resolves.toMatchObject({
      code: 4003,
      reason: 'handshake_timeout',
    });
    expect(forwarded).toBe(false);
  });

  it('cleans up a phone left idle without a desktop', async () => {
    const stub = room();
    const phone = await connect(stub, 'phone');
    const closed = nextEvent<CloseEvent>(phone, 'close');

    await runInDurableObject(stub, async (instance, state) => {
      const [server] = state.getWebSockets('phone');
      server?.serializeAttachment({
        connectionId: crypto.randomUUID(),
        connectedAt: Date.now() - DESKTOP_ABSENT_TIMEOUT_MS - 1,
        handshakeDeadline: null,
        hasForwardedFrame: true,
        authenticationConfirmed: true,
        authenticatedPeerConnectionId: crypto.randomUUID(),
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
