import { TextDecoder, TextEncoder } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => ''),
    getPath: vi.fn(() => ''),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

import {
  createHandshakeProof,
  deriveSessionKeys,
  MOBILE_REMOTE_PROTOCOL_VERSION,
  openEnvelope,
  sealEnvelope,
} from '../../../src/shared/mobileRemote';
import { createEncryptedPeer, handshakeTranscript } from '../encryptedPeer';
import { createMobileRemoteController, type MobileRemoteStatus } from '../mobileRemoteController';
import { installPtyFanout } from '../ptyFanout';
import type { RemotePeer } from '../remotePeer';
import type { RelaySocket, RelaySocketStatus } from '../relaySocket';

const mockedRemoteState = vi.hoisted(() => ({
  loadState: vi.fn(),
  listPtySessions: vi.fn(),
  getPtySession: vi.fn(),
}));
const ptyListeners: Array<(sid: string, chunk: string, seq: number) => void> = [];
vi.mock('../../db', () => ({
  loadState: mockedRemoteState.loadState,
}));
vi.mock('../../ptyHost', () => ({
  onPtyData: vi.fn((handler: (sid: string, chunk: string, seq: number) => void) => {
    ptyListeners.push(handler);
    return () => ptyListeners.splice(ptyListeners.indexOf(handler), 1);
  }),
  listPtySessions: mockedRemoteState.listPtySessions,
  getBufferSnapshot: vi.fn(),
  getPtySession: mockedRemoteState.getPtySession,
  inputPtySession: vi.fn(),
  resizePtySession: vi.fn(),
}));

const firstIdentity = { roomId: 'B'.repeat(43), secret: 'A'.repeat(43) };
const secondIdentity = { roomId: 'D'.repeat(43), secret: 'C'.repeat(43) };
const textDecoder = new TextDecoder();

function navigationSnapshot(sessionId = 's1'): string {
  return JSON.stringify({
    version: 1,
    activeId: sessionId,
    groups: [{ id: 'g1', name: 'Work', collapsed: false, kind: 'normal' }],
    sessions: [{ id: sessionId, name: 'Live', cwd: '/work', groupId: 'g1', state: 'idle' }],
  });
}

class FakeRelaySocket implements RelaySocket {
  readonly sent: string[] = [];
  readonly statusHandlers = new Set<(status: RelaySocketStatus) => void>();
  readonly messageHandlers = new Set<(message: string) => void>();
  readonly url = 'wss://relay.example/relay/room?role=desktop';
  close = vi.fn();
  connect = vi.fn();

  send(message: string): void {
    this.sent.push(message);
  }

  onMessage(handler: (message: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: (status: RelaySocketStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  emitStatus(status: RelaySocketStatus): void {
    for (const handler of this.statusHandlers) handler(status);
  }

  emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) handler(JSON.stringify(message));
  }
}

describe('desktop mobile remote controller', () => {
  beforeEach(() => {
    ptyListeners.splice(0);
    mockedRemoteState.loadState.mockReset();
    mockedRemoteState.listPtySessions.mockReset();
    mockedRemoteState.getPtySession.mockReset();
    mockedRemoteState.loadState.mockReturnValue(navigationSnapshot());
    mockedRemoteState.listPtySessions.mockReturnValue([{
      sid: 's1',
      cwd: '/work',
      pid: 1,
      geometry: { cols: 80, rows: 24, epoch: 0 },
      cols: 80,
      rows: 24,
    }]);
    mockedRemoteState.getPtySession.mockReturnValue({
      sid: 's1',
      cwd: '/work',
      pid: 1,
      geometry: { cols: 80, rows: 24, epoch: 0 },
      cols: 80,
      rows: 24,
    });
  });

  it('never forwards application traffic after a failed phone proof', async () => {
    const socket = new FakeRelaySocket();
    const handleMessage = vi.fn();
    const peer = createEncryptedPeer({
      pairing: firstIdentity,
      socket,
      handleMessage,
      randomValues: (bytes) => {
        bytes.fill(7);
        return bytes;
      },
    });

    peer.start();
    socket.emitStatus('open');
    const desktopHello = JSON.parse(socket.sent[0]!) as {
      connectionId: string;
      nonce: string;
    };
    socket.emitMessage({
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: firstIdentity.roomId,
      nonce: 'C'.repeat(22),
    });
    socket.emitMessage({
      type: 'handshake.proof',
      connectionId: firstIdentity.roomId,
      proof: 'invalid',
    });
    socket.emitMessage({ type: 'sessions.list' });

    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(4003, 'invalid_proof'),
    );
    expect(desktopHello.connectionId).toBe(firstIdentity.roomId);
    expect(peer.authenticated).toBe(false);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('serializes back-to-back phone hello and proof before accepting encrypted traffic', async () => {
    const socket = new FakeRelaySocket();
    const handleMessage = vi.fn();
    const peer = createEncryptedPeer({
      pairing: firstIdentity,
      socket,
      handleMessage,
      randomValues: (bytes) => {
        bytes.fill(9);
        return bytes;
      },
    });
    peer.start();
    socket.emitStatus('open');
    const desktopHello = JSON.parse(socket.sent[0]!) as {
      type: 'handshake.hello';
      version: 1;
      role: 'desktop';
      connectionId: string;
      nonce: string;
    };
    const phoneHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: firstIdentity.roomId,
      nonce: 'E'.repeat(22),
    } as const;
    const proof = await createHandshakeProof(
      firstIdentity.secret,
      handshakeTranscript(desktopHello, phoneHello, 'phone'),
    );

    socket.emitMessage(phoneHello);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    expect(JSON.parse(socket.sent[1]!).type).toBe('handshake.hello');
    expect(JSON.parse(socket.sent[2]!).type).toBe('handshake.proof');
    socket.emitMessage({
      type: 'handshake.proof',
      connectionId: firstIdentity.roomId,
      proof,
    });

    await vi.waitFor(() => expect(peer.authenticated).toBe(true));
    expect(
      socket.sent.some((message) => JSON.parse(message).type === 'relay.authenticated'),
    ).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('rejects a reflected desktop proof as a phone proof', async () => {
    const socket = new FakeRelaySocket();
    const peer = createEncryptedPeer({
      pairing: firstIdentity,
      socket,
      handleMessage: vi.fn(),
      randomValues: (bytes) => {
        bytes.fill(10);
        return bytes;
      },
    });
    peer.start();
    socket.emitStatus('open');
    const phoneHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: firstIdentity.roomId,
      nonce: 'R'.repeat(22),
    } as const;

    socket.emitMessage(phoneHello);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    const reflectedProof = JSON.parse(socket.sent[2]!) as {
      type: 'handshake.proof';
      connectionId: string;
      proof: string;
    };
    socket.emitMessage(reflectedProof);

    await vi.waitFor(() =>
      expect(socket.close).toHaveBeenCalledWith(4003, 'invalid_proof'),
    );
    expect(peer.authenticated).toBe(false);
  });

  it('does not dispatch a decrypted command after the peer is closed', async () => {
    const socket = new FakeRelaySocket();
    const handleMessage = vi.fn();
    const peer = createEncryptedPeer({
      pairing: firstIdentity,
      socket,
      handleMessage,
      randomValues: (bytes) => {
        bytes.fill(12);
        return bytes;
      },
    });
    peer.start();
    socket.emitStatus('open');
    const desktopHello = JSON.parse(socket.sent[0]!) as {
      type: 'handshake.hello';
      version: 1;
      role: 'desktop';
      connectionId: string;
      nonce: string;
    };
    const phoneHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: firstIdentity.roomId,
      nonce: 'F'.repeat(22),
    } as const;
    socket.emitMessage(phoneHello);
    socket.emitMessage({
      type: 'handshake.proof',
      connectionId: firstIdentity.roomId,
      proof: await createHandshakeProof(
        firstIdentity.secret,
        handshakeTranscript(desktopHello, phoneHello, 'phone'),
      ),
    });
    await vi.waitFor(() => expect(peer.authenticated).toBe(true));
    const phoneKeys = await deriveSessionKeys({
      ...firstIdentity,
      desktopNonce: desktopHello.nonce,
      phoneNonce: phoneHello.nonce,
      role: 'phone',
    });
    const envelope = await sealEnvelope(
      phoneKeys.send,
      new TextEncoder().encode('{"type":"sessions.list"}'),
    );

    socket.emitMessage(envelope);
    await Promise.resolve();
    peer.close();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('sends sessions.list and sessions.navigator after authentication', async () => {
    const socket = new FakeRelaySocket();
    const controller = await createMobileRemoteController({
      relayUrl: 'https://relay.example.workers.dev',
      pairingStore: {
        loadOrCreate: vi.fn(async () => firstIdentity),
        delete: vi.fn(),
      },
      createSocket: () => socket,
    });

    socket.emitStatus('open');
    const desktopHello = JSON.parse(socket.sent[0]!) as {
      type: 'handshake.hello';
      version: 1;
      role: 'desktop';
      connectionId: string;
      nonce: string;
    };
    const phoneHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'phone',
      connectionId: firstIdentity.roomId,
      nonce: 'G'.repeat(22),
    } as const;
    socket.emitMessage(phoneHello);
    socket.emitMessage({
      type: 'handshake.proof',
      connectionId: firstIdentity.roomId,
      proof: await createHandshakeProof(
        firstIdentity.secret,
        handshakeTranscript(desktopHello, phoneHello, 'phone'),
      ),
    });

    await vi.waitFor(() =>
      expect(
        socket.sent.filter((message) => JSON.parse(message).type === 'encrypted'),
      ).toHaveLength(2),
    );

    const phoneKeys = await deriveSessionKeys({
      ...firstIdentity,
      desktopNonce: desktopHello.nonce,
      phoneNonce: phoneHello.nonce,
      role: 'phone',
    });
    const sentApplicationMessages = await Promise.all(
      socket.sent
        .map((message) => JSON.parse(message) as { type: string })
        .filter(
          (message): message is {
            type: 'encrypted';
            version: 1;
            connectionId: string;
            sequence: number;
            ciphertext: string;
          } => message.type === 'encrypted',
        )
        .map(async (envelope) =>
          JSON.parse(textDecoder.decode(await openEnvelope(phoneKeys.receive, envelope))),
        ),
    );

    expect(sentApplicationMessages.slice(0, 2)).toEqual([
      { type: 'sessions.list', sessions: expect.any(Array) },
      {
        type: 'sessions.navigator',
        version: 1,
        model: expect.objectContaining({ groups: expect.any(Array) }),
      },
    ]);

    controller.close();
  });

  it('fans PTY output only to peers subscribed to the emitting SID', () => {
    const matching: RemotePeer = {
      subscribedSid: 'sid-a',
      send: vi.fn(),
    };
    const other: RemotePeer = {
      subscribedSid: 'sid-b',
      send: vi.fn(),
    };
    const uninstall = installPtyFanout(new Set([matching, other]));

    ptyListeners[0]?.('sid-a', 'chunk', 42);

    expect(matching.send).toHaveBeenCalledWith({
      type: 'pty.data',
      sid: 'sid-a',
      chunk: 'chunk',
      seq: 42,
      geometryEpoch: 0,
    });
    expect(other.send).not.toHaveBeenCalled();
    uninstall();
  });

  it('reports secure storage unavailability without opening a socket', async () => {
    const createSocket = vi.fn();
    const controller = await createMobileRemoteController({
      relayUrl: 'https://relay.example.workers.dev',
      pairingStore: {
        loadOrCreate: vi.fn(async () => null),
        delete: vi.fn(),
      },
      createSocket,
    });

    expect(controller.getStatus()).toEqual({
      kind: 'unavailable',
      reason: 'secure-storage-unavailable',
    });
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('rotate closes the old socket, deletes credentials, and publishes a new pairing URL', async () => {
    const identities = [firstIdentity, secondIdentity];
    const pairingStore = {
      loadOrCreate: vi.fn(async () => identities.shift() ?? null),
      delete: vi.fn(async () => undefined),
    };
    const sockets: FakeRelaySocket[] = [];
    const statuses: MobileRemoteStatus[] = [];
    const controller = await createMobileRemoteController({
      relayUrl: 'https://relay.example.workers.dev',
      pairingStore,
      createSocket: () => {
        const socket = new FakeRelaySocket();
        sockets.push(socket);
        return socket;
      },
    });
    controller.subscribe((status) => statuses.push(status));
    const oldUrl = controller.getPairingUrl();

    await controller.rotate();

    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(pairingStore.delete).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(controller.getPairingUrl()).not.toBe(oldUrl);
    expect(controller.getPairingUrl()).toContain(secondIdentity.roomId);
    expect(statuses.at(-1)).toEqual({ kind: 'connecting' });
    controller.close();
  });

  it('serializes concurrent rotations so no obsolete socket remains active', async () => {
    const thirdIdentity = { roomId: 'F'.repeat(43), secret: 'E'.repeat(43) };
    const pendingLoads: Array<(identity: typeof firstIdentity) => void> = [];
    const pairingStore = {
      loadOrCreate: vi
        .fn()
        .mockResolvedValueOnce(firstIdentity)
        .mockImplementation(
          () =>
            new Promise<typeof firstIdentity>((resolve) => {
              pendingLoads.push(resolve);
            }),
        ),
      delete: vi.fn(async () => undefined),
    };
    const sockets: FakeRelaySocket[] = [];
    const controller = await createMobileRemoteController({
      relayUrl: 'https://relay.example.workers.dev',
      pairingStore,
      createSocket: () => {
        const socket = new FakeRelaySocket();
        sockets.push(socket);
        return socket;
      },
    });

    const firstRotation = controller.rotate();
    const secondRotation = controller.rotate();
    await vi.waitFor(() => expect(pendingLoads).toHaveLength(1));
    pendingLoads[0]!(secondIdentity);
    await firstRotation;
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
      expect(pendingLoads).toHaveLength(2);
    });
    pendingLoads[1]!(thirdIdentity);
    await secondRotation;

    expect(sockets).toHaveLength(3);
    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(sockets[1]!.close).toHaveBeenCalled();
    expect(sockets[2]!.close).not.toHaveBeenCalled();
    expect(controller.getPairingUrl()).toContain(thirdIdentity.roomId);
    controller.close();
  });

  it('does not reconnect the old credential when resumed during rotation', async () => {
    let resolveRotatedIdentity: ((identity: typeof firstIdentity) => void) | undefined;
    const pairingStore = {
      loadOrCreate: vi
        .fn()
        .mockResolvedValueOnce(firstIdentity)
        .mockImplementationOnce(
          () =>
            new Promise<typeof firstIdentity>((resolve) => {
              resolveRotatedIdentity = resolve;
            }),
        ),
      delete: vi.fn(async () => undefined),
    };
    const sockets: FakeRelaySocket[] = [];
    const controller = await createMobileRemoteController({
      relayUrl: 'https://relay.example.workers.dev',
      pairingStore,
      createSocket: () => {
        const socket = new FakeRelaySocket();
        sockets.push(socket);
        return socket;
      },
    });
    controller.pause();

    const rotation = controller.rotate();
    await vi.waitFor(() => expect(resolveRotatedIdentity).toBeTypeOf('function'));
    controller.resume();

    expect(sockets).toHaveLength(1);
    resolveRotatedIdentity!(secondIdentity);
    await rotation;
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(sockets[1]!.close).not.toHaveBeenCalled();
    expect(controller.getPairingUrl()).toContain(secondIdentity.roomId);
    controller.close();
  });

  it('recovers after a failed rotation and reports secure storage unavailable', async () => {
    const pairingStore = {
      loadOrCreate: vi
        .fn()
        .mockResolvedValueOnce(firstIdentity)
        .mockResolvedValueOnce(secondIdentity),
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('storage unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const sockets: FakeRelaySocket[] = [];
    const controller = await createMobileRemoteController({
      relayUrl: 'https://relay.example.workers.dev',
      pairingStore,
      createSocket: () => {
        const socket = new FakeRelaySocket();
        sockets.push(socket);
        return socket;
      },
    });

    await expect(controller.rotate()).resolves.toBeUndefined();
    expect(controller.getStatus()).toEqual({
      kind: 'unavailable',
      reason: 'secure-storage-unavailable',
    });

    await expect(controller.rotate()).resolves.toBeUndefined();
    expect(pairingStore.delete).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(controller.getPairingUrl()).toContain(secondIdentity.roomId);
    controller.close();
  });
});
