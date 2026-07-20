import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  createHandshakeProof,
  deriveSessionKeys,
  sealEnvelope,
} from '../../src/shared/mobileRemote';
import {
  createRelayClient,
  handshakeTranscript,
  type PhoneConnectionStatus,
} from '../../src/mobile/relayClient';

const ROOM_ID = 'B'.repeat(43);
const SECRET = 'A'.repeat(43);

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function parseSent(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

describe('phone relay client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('uses a fresh nonce for every socket and caps exponential reconnect at 10 seconds', () => {
    const sockets: FakeWebSocket[] = [];
    const delays: number[] = [];
    let byte = 0;
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      randomValues: (bytes) => {
        bytes.fill((byte += 1));
        return bytes;
      },
      schedule: (handler, delay) => {
        delays.push(delay);
        return setTimeout(handler, 0);
      },
    });

    client.connect();
    for (let index = 0; index < 7; index += 1) {
      sockets[index]!.open();
      sockets[index]!.close();
      vi.runOnlyPendingTimers();
    }

    const openedSockets = sockets.filter((socket) => socket.sent.length > 0);
    const nonces = openedSockets.map((socket) => parseSent(socket)[0]!.nonce);
    expect(new Set(nonces).size).toBe(openedSockets.length);
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    client.close();
  });

  it('surfaces protocol mismatch as update_required', async () => {
    const socket = new FakeWebSocket();
    const statuses: PhoneConnectionStatus[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
    });
    client.onStatus((status) => statuses.push(status));
    client.connect();
    socket.open();

    socket.receive({
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION + 1,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: 'C'.repeat(22),
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe('update_required'));
    expect(socket.readyState).toBe(3);
  });

  it('does not emit encrypted application messages until desktop proof verifies', async () => {
    const socket = new FakeWebSocket();
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      randomValues: (bytes) => {
        bytes.fill(7);
        return bytes;
      },
    });
    client.connect();
    socket.open();
    const phoneHello = parseSent(socket)[0]!;
    const desktopNonce = 'C'.repeat(22);
    const desktopHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: desktopNonce,
    } as const;

    socket.receive(desktopHello);
    await vi.waitFor(() => {
      expect(parseSent(socket).some((message) => message.type === 'handshake.proof')).toBe(true);
    });
    const pendingSend = client.send({ type: 'sessions.list' });
    expect(parseSent(socket).some((message) => message.type === 'encrypted')).toBe(false);

    const transcript = handshakeTranscript(desktopHello, {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: ROOM_ID,
      nonce: String(phoneHello.nonce),
    });
    socket.receive({
      type: 'handshake.proof',
      connectionId: ROOM_ID,
      proof: await createHandshakeProof(SECRET, transcript),
    });
    await pendingSend;

    expect(parseSent(socket).some((message) => message.type === 'encrypted')).toBe(true);
  });

  it('serializes back-to-back handshake messages', async () => {
    const socket = new FakeWebSocket();
    const statuses: PhoneConnectionStatus[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      randomValues: (bytes) => {
        bytes.fill(11);
        return bytes;
      },
    });
    client.onStatus((status) => statuses.push(status));
    client.connect();
    socket.open();
    const phoneHello = parseSent(socket)[0]!;
    const desktopHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: 'E'.repeat(22),
    } as const;
    const proof = await createHandshakeProof(
      SECRET,
      handshakeTranscript(desktopHello, {
        type: 'handshake.hello',
        version: MOBILE_REMOTE_PROTOCOL_VERSION,
        role: 'phone',
        connectionId: ROOM_ID,
        nonce: String(phoneHello.nonce),
      }),
    );

    socket.receive(desktopHello);
    socket.receive({
      type: 'handshake.proof',
      connectionId: ROOM_ID,
      proof,
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'));
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('decrypts authenticated desktop application messages', async () => {
    const socket = new FakeWebSocket();
    const messages: unknown[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      randomValues: (bytes) => {
        bytes.fill(9);
        return bytes;
      },
    });
    client.onMessage((message) => messages.push(message));
    client.connect();
    socket.open();
    const phoneHello = parseSent(socket)[0]!;
    const desktopHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: 'D'.repeat(22),
    } as const;
    socket.receive(desktopHello);
    await vi.waitFor(() => expect(parseSent(socket).length).toBeGreaterThan(1));
    const transcript = handshakeTranscript(desktopHello, {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: ROOM_ID,
      nonce: String(phoneHello.nonce),
    });
    socket.receive({
      type: 'handshake.proof',
      connectionId: ROOM_ID,
      proof: await createHandshakeProof(SECRET, transcript),
    });
    const desktopKeys = await deriveSessionKeys({
      secret: SECRET,
      roomId: ROOM_ID,
      desktopNonce: desktopHello.nonce,
      phoneNonce: String(phoneHello.nonce),
      role: 'desktop',
    });
    const envelope = await sealEnvelope(
      desktopKeys.send,
      new TextEncoder().encode('{"type":"sessions.list","sessions":[]}'),
    );
    socket.receive(envelope);
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'sessions.list', sessions: [] }]));
  });
});
