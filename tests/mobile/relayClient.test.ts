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

  error(): void {
    this.onerror?.();
  }
}

function parseSent(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

async function authenticate(
  client: ReturnType<typeof createRelayClient>,
  socket: FakeWebSocket,
  desktopNonce: string,
): Promise<void> {
  const statuses: PhoneConnectionStatus[] = [];
  const offStatus = client.onStatus((status) => statuses.push(status));
  const phoneHello = parseSent(socket).find((message) => message.type === 'handshake.hello')!;
  const desktopHello = {
    type: 'handshake.hello',
    version: MOBILE_REMOTE_PROTOCOL_VERSION,
    role: 'desktop',
    connectionId: ROOM_ID,
    nonce: desktopNonce,
  } as const;
  socket.receive(desktopHello);
  await vi.waitFor(() =>
    expect(parseSent(socket).some((message) => message.type === 'handshake.proof')).toBe(true),
  );
  socket.receive({
    type: 'handshake.proof',
    connectionId: ROOM_ID,
    proof: await createHandshakeProof(
      SECRET,
      handshakeTranscript(desktopHello, {
        type: 'handshake.hello',
        version: MOBILE_REMOTE_PROTOCOL_VERSION,
        role: 'phone',
        connectionId: ROOM_ID,
        nonce: String(phoneHello.nonce),
      }, 'desktop'),
    ),
  });
  await vi.waitFor(() => expect(statuses).toContain('connected'));
  offStatus();
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
    }, 'desktop');
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
      }, 'desktop'),
    );

    socket.receive(desktopHello);
    socket.receive({
      type: 'handshake.proof',
      connectionId: ROOM_ID,
      proof,
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe('connected'));
    expect(parseSent(socket).some((message) => message.type === 'relay.authenticated')).toBe(true);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('serializes application envelopes queued together after reconnect authentication', async () => {
    const socket = new FakeWebSocket();
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      randomValues: (bytes) => {
        bytes.fill(13);
        return bytes;
      },
    });
    const sends: Promise<void>[] = [];
    client.onStatus((status) => {
      if (status === 'connected') {
        sends.push(client.send({ type: 'sessions.list' }));
        sends.push(client.send({ type: 'session.snapshot', sid: 'mobile-e2e' }));
      }
    });
    client.connect();
    socket.open();
    const phoneHello = parseSent(socket)[0]!;
    const desktopHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: 'G'.repeat(22),
    } as const;
    socket.receive(desktopHello);
    const transcript = handshakeTranscript(desktopHello, {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: ROOM_ID,
      nonce: String(phoneHello.nonce),
    }, 'desktop');
    await vi.waitFor(() =>
      expect(parseSent(socket).some((message) => message.type === 'handshake.proof')).toBe(true),
    );

    socket.receive({
      type: 'handshake.proof',
      connectionId: ROOM_ID,
      proof: await createHandshakeProof(SECRET, transcript),
    });
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    await Promise.all(sends);

    const sequences = parseSent(socket)
      .filter((message) => message.type === 'encrypted')
      .map((message) => message.sequence);
    expect(sequences).toEqual([1, 2]);
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
    }, 'desktop');
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
      new TextEncoder().encode('{"type":"pty.data","sid":"s1","seq":1,"chunk":"tail","geometryEpoch":4}'),
    );
    socket.receive(envelope);
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'pty.data', sid: 's1', seq: 1, chunk: 'tail', geometryEpoch: 4 }]));
  });

  it('rejects an authenticated malformed geometry message before delivery', async () => {
    const socket = new FakeWebSocket();
    const messages: unknown[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      randomValues: (bytes) => {
        bytes.fill(17);
        return bytes;
      },
    });
    client.onMessage((message) => messages.push(message));
    client.connect();
    socket.open();
    const phoneHello = parseSent(socket)[0]!;
    const desktopNonce = 'M'.repeat(22);
    const desktopHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: desktopNonce,
    } as const;
    socket.receive(desktopHello);
    await vi.waitFor(() =>
      expect(parseSent(socket).some((message) => message.type === 'handshake.proof')).toBe(true),
    );
    socket.receive({
      type: 'handshake.proof',
      connectionId: ROOM_ID,
      proof: await createHandshakeProof(
        SECRET,
        handshakeTranscript(desktopHello, {
          type: 'handshake.hello',
          version: MOBILE_REMOTE_PROTOCOL_VERSION,
          role: 'phone',
          connectionId: ROOM_ID,
          nonce: String(phoneHello.nonce),
        }, 'desktop'),
      ),
    });
    await vi.waitFor(() => expect(parseSent(socket).some((message) => message.type === 'relay.authenticated')).toBe(true));
    const desktopKeys = await deriveSessionKeys({
      secret: SECRET,
      roomId: ROOM_ID,
      desktopNonce,
      phoneNonce: String(phoneHello.nonce),
      role: 'desktop',
    });
    const envelope = await sealEnvelope(
      desktopKeys.send,
      new TextEncoder().encode(JSON.stringify({
        type: 'pty.data',
        sid: 's1',
        seq: 1,
        chunk: 'bad',
        geometryEpoch: -1,
      })),
    );
    socket.receive(envelope);
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(messages).toEqual([]);
    client.close();
  });

  it.each([
    {
      description: 'legacy sessions.list cols/rows',
      payload: {
        type: 'sessions.list',
        sessions: [{ sid: 's1', cwd: 'C:\\work', cols: 120, rows: 30 }],
      },
    },
    {
      description: 'legacy session.snapshot data and legacy dimensions',
      payload: {
        type: 'session.snapshot',
        sid: 's1',
        seq: 1,
        data: 'snapshot',
        cols: 120,
        rows: 30,
      },
    },
    {
      description: 'session.snapshot missing geometry',
      payload: {
        type: 'session.snapshot',
        sid: 's1',
        seq: 1,
        snapshot: 'snapshot',
      },
    },
    {
      description: 'pty.data missing geometryEpoch',
      payload: {
        type: 'pty.data',
        sid: 's1',
        seq: 1,
        chunk: 'tail',
      },
    },
  ])('rejects legacy decrypted server messages before delivery: $description', async ({ payload }) => {
    const socket = new FakeWebSocket();
    const messages: unknown[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      randomValues: (bytes) => {
        bytes.fill(19);
        return bytes;
      },
    });
    client.onMessage((message) => messages.push(message));
    client.connect();
    socket.open();
    const phoneHello = parseSent(socket)[0]!;
    const desktopNonce = 'N'.repeat(22);
    const desktopHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: desktopNonce,
    } as const;
    socket.receive(desktopHello);
    await vi.waitFor(() =>
      expect(parseSent(socket).some((message) => message.type === 'handshake.proof')).toBe(true),
    );
    socket.receive({
      type: 'handshake.proof',
      connectionId: ROOM_ID,
      proof: await createHandshakeProof(
        SECRET,
        handshakeTranscript(desktopHello, {
          type: 'handshake.hello',
          version: MOBILE_REMOTE_PROTOCOL_VERSION,
          role: 'phone',
          connectionId: ROOM_ID,
          nonce: String(phoneHello.nonce),
        }, 'desktop'),
      ),
    });
    await vi.waitFor(() => expect(parseSent(socket).some((message) => message.type === 'relay.authenticated')).toBe(true));
    const desktopKeys = await deriveSessionKeys({
      secret: SECRET,
      roomId: ROOM_ID,
      desktopNonce,
      phoneNonce: String(phoneHello.nonce),
      role: 'desktop',
    });
    const envelope = await sealEnvelope(
      desktopKeys.send,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    socket.receive(envelope);
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    expect(messages).toEqual([]);
    client.close();
  });

  it('rejects terminal input while unauthenticated instead of replaying it later', async () => {
    const socket = new FakeWebSocket();
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
    });
    client.connect();
    socket.open();

    await expect(
      client.send({ type: 'session.input', sid: 'mobile-e2e', data: 'rm -rf stale\r' }),
    ).rejects.toThrow('not_authenticated');

    await authenticate(client, socket, 'H'.repeat(22));
    expect(parseSent(socket).filter((message) => message.type === 'encrypted')).toHaveLength(0);
    client.close();
  });

  it('coalesces duplicate offline recovery requests and bounds the recovery queue', async () => {
    const socket = new FakeWebSocket();
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
    });
    client.connect();
    socket.open();

    const firstList = client.send({ type: 'sessions.list' });
    const secondList = client.send({ type: 'sessions.list' });
    const snapshots = Array.from({ length: 32 }, (_, index) =>
      client.send({ type: 'session.snapshot', sid: `sid-${index}` }),
    );
    await expect(snapshots.at(-1)).rejects.toThrow('offline_queue_full');

    await authenticate(client, socket, 'I'.repeat(22));
    await Promise.all([firstList, secondList, ...snapshots.slice(0, -1)]);
    expect(parseSent(socket).filter((message) => message.type === 'encrypted')).toHaveLength(32);
    client.close();
  });

  it('requeues recovery encrypted for an obsolete connection onto the authenticated socket', async () => {
    const sockets: FakeWebSocket[] = [];
    let releaseEncryption!: () => void;
    const encryptionStarted = new Promise<void>((resolve) => {
      releaseEncryption = resolve;
    });
    let encryptionCalls = 0;
    let unblockFirstEncryption!: () => void;
    const firstEncryptionBlocked = new Promise<void>((resolve) => {
      unblockFirstEncryption = resolve;
    });
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      seal: async (key, plaintext) => {
        encryptionCalls += 1;
        if (encryptionCalls === 1) {
          releaseEncryption();
          await firstEncryptionBlocked;
        }
        return sealEnvelope(key, plaintext);
      },
    });
    client.connect();
    sockets[0]!.open();
    await authenticate(client, sockets[0]!, 'J'.repeat(22));

    const pending = client.send({ type: 'sessions.list' });
    await encryptionStarted;
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.open();
    await authenticate(client, sockets[1]!, 'K'.repeat(22));
    unblockFirstEncryption();
    await pending;

    expect(parseSent(sockets[0]!).filter((message) => message.type === 'encrypted')).toHaveLength(0);
    expect(parseSent(sockets[1]!).filter((message) => message.type === 'encrypted')).toHaveLength(1);
    client.close();
  });

  it('rejects a resize queued before reconnect and does not replay it after reconnect', async () => {
    const sockets: FakeWebSocket[] = [];
    const plaintexts: string[] = [];
    let unblockFirstEncryption!: () => void;
    const firstEncryptionBlocked = new Promise<void>((resolve) => {
      unblockFirstEncryption = resolve;
    });
    let firstEncryptionStarted!: () => void;
    const encryptionStarted = new Promise<void>((resolve) => {
      firstEncryptionStarted = resolve;
    });
    let encryptionCalls = 0;
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      seal: async (key, plaintext) => {
        encryptionCalls += 1;
        if (encryptionCalls === 1) {
          firstEncryptionStarted();
          await firstEncryptionBlocked;
        }
        plaintexts.push(new TextDecoder().decode(plaintext));
        return sealEnvelope(key, plaintext);
      },
    });
    client.connect();
    sockets[0]!.open();
    await authenticate(client, sockets[0]!, 'S'.repeat(22));

    const stale = client.send({
      type: 'session.input',
      sid: 'mobile-e2e',
      data: 'first',
    });
    await encryptionStarted;
    sockets[0]!.close();
    const latest = client.send({
      type: 'session.input',
      sid: 'mobile-e2e',
      data: 'latest',
    });

    const staleResult = stale.then(
      () => null,
      (error: unknown) => error,
    );
    const latestResult = latest.then(
      () => null,
      (error: unknown) => error,
    );
    unblockFirstEncryption();
    await expect(staleResult).resolves.toMatchObject({ message: 'connection_changed' });
    await expect(latestResult).resolves.toMatchObject({ message: 'not_authenticated' });
    client.close();

    expect(plaintexts).toEqual([
      JSON.stringify({
        type: 'session.input',
        sid: 'mobile-e2e',
        data: 'first',
      }),
    ]);
  });

  it('rejects terminal input if its connection changes during encryption', async () => {
    const sockets: FakeWebSocket[] = [];
    let encryptionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      encryptionStarted = resolve;
    });
    let unblockEncryption!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblockEncryption = resolve;
    });
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      seal: async (key, plaintext) => {
        encryptionStarted();
        await blocked;
        return sealEnvelope(key, plaintext);
      },
    });
    client.connect();
    sockets[0]!.open();
    await authenticate(client, sockets[0]!, 'L'.repeat(22));

    const pending = client.send({ type: 'session.input', sid: 'mobile-e2e', data: 'pwd\r' });
    const rejection = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    sockets[0]!.close();
    unblockEncryption();

    await expect(rejection).resolves.toMatchObject({ message: 'connection_changed' });
    client.close();
  });

  it('rejects authenticated terminal input still queued when the socket disconnects', async () => {
    const socket = new FakeWebSocket();
    let encryptionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      encryptionStarted = resolve;
    });
    let unblockEncryption!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblockEncryption = resolve;
    });
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      seal: async (key, plaintext) => {
        encryptionStarted();
        await blocked;
        return sealEnvelope(key, plaintext);
      },
    });
    client.connect();
    socket.open();
    await authenticate(client, socket, 'O'.repeat(22));

    const recovery = client.send({ type: 'sessions.list' });
    const recoveryResult = recovery.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    const input = client.send({ type: 'session.input', sid: 'mobile-e2e', data: 'stale\r' });
    const inputResult = input.then(
      () => null,
      (error: unknown) => error,
    );
    socket.close();

    await expect(inputResult).resolves.toMatchObject({ message: 'connection_changed' });
    unblockEncryption();
    client.close();
    await expect(recoveryResult).resolves.toMatchObject({ message: 'client_closed' });
  });

  it('sends recovery heartbeats and reconnects after inbound inactivity', async () => {
    const socket = new FakeWebSocket();
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => socket,
      heartbeatIntervalMs: 100,
      inactivityTimeoutMs: 300,
    });
    client.connect();
    socket.open();
    await authenticate(client, socket, 'M'.repeat(22));
    const encryptedBeforeHeartbeat = parseSent(socket).filter(
      (message) => message.type === 'encrypted',
    ).length;

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() =>
      expect(
        parseSent(socket).filter((message) => message.type === 'encrypted').length,
      ).toBeGreaterThan(encryptedBeforeHeartbeat),
    );
    await vi.advanceTimersByTimeAsync(200);

    expect(socket.readyState).toBe(3);
    client.close();
  });

  it('retry cancels the pending reconnect timer and resets backoff to 500ms', () => {
    const sockets: FakeWebSocket[] = [];
    const delays: number[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: (handler, delay) => {
        delays.push(delay);
        // Never fires within the test — proves retry() does not wait for it.
        return setTimeout(handler, 100_000);
      },
    });

    client.connect();
    sockets[0]!.open();
    sockets[0]!.close();
    expect(delays).toEqual([500]);
    expect(sockets).toHaveLength(1);

    client.retry();
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    sockets[1]!.close();
    expect(delays).toEqual([500, 500]);

    client.close();
  });

  it('retry is a no-op once authentication or protocol failure has blocked the connection', async () => {
    const sockets: FakeWebSocket[] = [];
    const statuses: PhoneConnectionStatus[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    client.onStatus((status) => statuses.push(status));
    client.connect();
    sockets[0]!.open();
    sockets[0]!.receive({
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION + 1,
      role: 'desktop',
      connectionId: ROOM_ID,
      nonce: 'Z'.repeat(22),
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe('update_required'));
    expect(sockets).toHaveLength(1);

    client.retry();
    expect(sockets).toHaveLength(1);
  });

  it('retry immediately replaces a socket stuck in the onerror window instead of waiting for its close', async () => {
    const sockets: FakeWebSocket[] = [];
    const statuses: PhoneConnectionStatus[] = [];
    const delays: number[] = [];
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: (handler, delay) => {
        delays.push(delay);
        // Never fires within the test — proves the old socket's own close
        // does not schedule a second, duplicate reconnect.
        return setTimeout(handler, 100_000);
      },
    });
    client.onStatus((status) => statuses.push(status));
    client.connect();
    sockets[0]!.open();

    // retry() on a healthy (not-yet-errored) socket stays a no-op.
    client.retry();
    expect(sockets).toHaveLength(1);

    await authenticate(client, sockets[0]!, 'U'.repeat(22));

    // Queue one unsafe (session.input) and one bounded recovery
    // (sessions.list) message on the still-open, authenticated socket before
    // it errors, without yielding the event loop so both remain unflushed.
    const unsafe = client
      .send({ type: 'session.input', sid: 'mobile-e2e', data: 'stale\r' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    const recovery = client.send({ type: 'sessions.list' }).then(
      () => null,
      (error: unknown) => error,
    );

    sockets[0]!.error();
    expect(statuses.at(-1)).toBe('connection_error');
    expect(sockets).toHaveLength(1);
    expect(delays).toHaveLength(0);

    client.retry();

    // Exactly one fresh socket, opened immediately (no scheduled delay).
    expect(sockets).toHaveLength(2);
    expect(delays).toHaveLength(0);
    // The errored transport was retired (closed) as part of the retry.
    expect(sockets[0]!.readyState).toBe(3);

    const unsafeResult = await unsafe;
    expect(unsafeResult).toMatchObject({ message: 'connection_changed' });

    // The bounded recovery request survived the retry and is delivered once
    // the new (second-generation) socket authenticates — proving stale
    // frames/timers from the retired socket never mutate the new generation
    // and no duplicate automatic reconnect fired from its late close.
    sockets[1]!.open();
    await authenticate(client, sockets[1]!, 'V'.repeat(22));
    await recovery;
    expect(parseSent(sockets[1]!).some((message) => message.type === 'encrypted')).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(delays).toHaveLength(0);

    client.close();
  });

  it('rejects an unsafe session.submit if its connection changes during encryption and never resends it', async () => {
    const sockets: FakeWebSocket[] = [];
    let encryptionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      encryptionStarted = resolve;
    });
    let unblockEncryption!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblockEncryption = resolve;
    });
    const client = createRelayClient({
      relayUrl: 'https://relay.example',
      pairing: { roomId: ROOM_ID, secret: SECRET },
      createWebSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      seal: async (key, plaintext) => {
        encryptionStarted();
        await blocked;
        return sealEnvelope(key, plaintext);
      },
    });
    client.connect();
    sockets[0]!.open();
    await authenticate(client, sockets[0]!, 'P'.repeat(22));

    const pending = client.send({
      type: 'session.submit',
      sid: 'mobile-e2e',
      requestId: 'req-1',
      draft: 'echo hi\r',
    });
    const rejection = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    sockets[0]!.close();
    unblockEncryption();

    await expect(rejection).resolves.toMatchObject({ message: 'connection_changed' });

    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.open();
    await authenticate(client, sockets[1]!, 'Q'.repeat(22));
    expect(
      parseSent(sockets[1]!).filter(
        (message) => message.type === 'encrypted',
      ),
    ).toHaveLength(0);
    client.close();
  });
});
