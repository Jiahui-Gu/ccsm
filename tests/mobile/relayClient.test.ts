import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  createHandshakeProof,
  deriveSessionKeys,
  openEnvelope,
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
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  open(): void {
    this.readyState = 1;
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

function sent(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

async function authenticate(
  client: ReturnType<typeof createRelayClient>,
  socket: FakeWebSocket,
  desktopNonce: string,
): Promise<void> {
  const phoneHello = sent(socket).find((message) => message.type === 'handshake.hello')!;
  const desktopHello = {
    type: 'handshake.hello',
    version: MOBILE_REMOTE_PROTOCOL_VERSION,
    role: 'desktop',
    connectionId: ROOM_ID,
    nonce: desktopNonce,
  } as const;
  socket.receive(desktopHello);
  await vi.waitFor(() =>
    expect(sent(socket).some((message) => message.type === 'handshake.proof')).toBe(true),
  );
  socket.receive({
    type: 'handshake.proof',
    connectionId: ROOM_ID,
    proof: await createHandshakeProof(
      SECRET,
      handshakeTranscript(
        desktopHello,
        {
          type: 'handshake.hello',
          version: MOBILE_REMOTE_PROTOCOL_VERSION,
          role: 'phone',
          connectionId: ROOM_ID,
          nonce: String(phoneHello.nonce),
        },
        'desktop',
      ),
    ),
  });
  await vi.waitFor(() =>
    expect(sent(socket).some((message) => message.type === 'relay.authenticated')).toBe(true),
  );
}

describe('phone relay client', () => {
  beforeEach(() => vi.useFakeTimers());

  it('uses a fresh nonce and caps reconnect delay at ten seconds', () => {
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

    const nonces = sockets.map((socket) => sent(socket)[0]?.nonce);
    expect(new Set(nonces).size).toBe(sockets.length);
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

  it('decrypts mirror frames after authenticating the desktop', async () => {
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
    const phoneHello = sent(socket)[0]!;
    await authenticate(client, socket, 'D'.repeat(22));
    const desktopKeys = await deriveSessionKeys({
      secret: SECRET,
      roomId: ROOM_ID,
      desktopNonce: 'D'.repeat(22),
      phoneNonce: String(phoneHello.nonce),
      role: 'desktop',
    });
    socket.receive(
      await sealEnvelope(
        desktopKeys.send,
        new TextEncoder().encode(
          '{"type":"mirror.frame","jpegBase64":"abc","width":800,"height":600}',
        ),
      ),
    );

    await vi.waitFor(() =>
      expect(messages).toEqual([
        {
          type: 'mirror.frame',
          jpegBase64: 'abc',
          width: 800,
          height: 600,
        },
      ]),
    );
    client.close();
  });

  it('replays only mirror.start after the socket changes', async () => {
    const sockets: FakeWebSocket[] = [];
    const plaintexts: string[] = [];
    let unblockEncryption!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblockEncryption = resolve;
    });
    let encryptionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      encryptionStarted = resolve;
    });
    let sealCalls = 0;
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      seal: async (key, plaintext) => {
        sealCalls += 1;
        if (sealCalls === 1) {
          encryptionStarted();
          await blocked;
        }
        plaintexts.push(new TextDecoder().decode(plaintext));
        return sealEnvelope(key, plaintext);
      },
    });
    client.connect();
    sockets[0]!.open();
    await authenticate(client, sockets[0]!, 'E'.repeat(22));

    const start = client.send({ type: 'mirror.start' });
    await started;
    const text = client.send({ type: 'mirror.text', text: 'do not replay' });
    sockets[0]!.close();
    await expect(text).rejects.toThrow('connection_changed');
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.open();
    await authenticate(client, sockets[1]!, 'F'.repeat(22));
    unblockEncryption();
    await start;

    const phoneHello = sent(sockets[1]!)[0]!;
    const phoneKeys = await deriveSessionKeys({
      secret: SECRET,
      roomId: ROOM_ID,
      desktopNonce: 'F'.repeat(22),
      phoneNonce: String(phoneHello.nonce),
      role: 'phone',
    });
    const encrypted = sent(sockets[1]!).find((message) => message.type === 'encrypted')!;
    expect(
      new TextDecoder().decode(
        await openEnvelope(phoneKeys.send, encrypted as never),
      ),
    ).toBe('{"type":"mirror.start"}');
    expect(plaintexts).not.toContain('{"type":"mirror.text","text":"do not replay"}');
    client.close();
  });
});
