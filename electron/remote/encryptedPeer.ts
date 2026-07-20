import { TextDecoder, TextEncoder } from 'node:util';
import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  createHandshakeProof,
  deriveSessionKeys,
  openEnvelope,
  sealEnvelope,
  type EncryptedEnvelope,
  type HandshakeHello,
  type HandshakeProof,
  type PairingIdentity,
  type RandomValues,
  type SessionKeys,
} from '../../src/shared/mobileRemote';
import type { RemotePeer } from './remotePeer';
import type { RelaySocket, RelaySocketStatus } from './relaySocket';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type EncryptedPeerFailure = 'protocol-mismatch' | 'authentication-failed';

export type EncryptedPeer = RemotePeer & {
  readonly authenticated: boolean;
  start(): void;
  close(): void;
};

export type EncryptedPeerOptions = {
  pairing: PairingIdentity;
  socket: RelaySocket;
  handleMessage(peer: RemotePeer, raw: string): Promise<void> | void;
  randomValues?: RandomValues;
  onAuthenticated?: () => void;
  onFailure?: (failure: EncryptedPeerFailure) => void;
};

function defaultRandomValues(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHello(value: unknown): value is HandshakeHello {
  return (
    isRecord(value) &&
    value.type === 'handshake.hello' &&
    typeof value.version === 'number' &&
    (value.role === 'desktop' || value.role === 'phone') &&
    typeof value.connectionId === 'string' &&
    typeof value.nonce === 'string'
  );
}

function isProof(value: unknown): value is HandshakeProof {
  return (
    isRecord(value) &&
    value.type === 'handshake.proof' &&
    typeof value.connectionId === 'string' &&
    typeof value.proof === 'string'
  );
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    isRecord(value) &&
    value.type === 'encrypted' &&
    typeof value.version === 'number' &&
    typeof value.connectionId === 'string' &&
    typeof value.sequence === 'number' &&
    typeof value.ciphertext === 'string'
  );
}

export function handshakeTranscript(
  desktop: HandshakeHello,
  phone: HandshakeHello,
  provingRole: 'desktop' | 'phone',
): string {
  return JSON.stringify([
    'ccsm-mobile-remote-handshake',
    MOBILE_REMOTE_PROTOCOL_VERSION,
    desktop.connectionId,
    desktop.nonce,
    phone.nonce,
    provingRole,
  ]);
}

export function createEncryptedPeer(options: EncryptedPeerOptions): EncryptedPeer {
  const randomValues = options.randomValues ?? defaultRandomValues;
  let authenticated = false;
  let started = false;
  let closed = false;
  let keys: SessionKeys | null = null;
  let desktopHello: HandshakeHello | null = null;
  let phoneHello: HandshakeHello | null = null;
  let generation = 0;
  let incomingMessages = Promise.resolve();
  let outgoingMessages = Promise.resolve();
  let offMessage: (() => void) | null = null;
  let offStatus: (() => void) | null = null;

  const fail = (failure: EncryptedPeerFailure, reason: string): void => {
    if (closed) return;
    authenticated = false;
    options.onFailure?.(failure);
    options.socket.close(failure === 'protocol-mismatch' ? 4002 : 4003, reason);
  };

  const beginHandshake = (): void => {
    generation += 1;
    authenticated = false;
    keys = null;
    phoneHello = null;
    desktopHello = {
      type: 'handshake.hello',
      version: MOBILE_REMOTE_PROTOCOL_VERSION,
      role: 'desktop',
      connectionId: options.pairing.roomId,
      nonce: encodeBase64Url(randomValues(new Uint8Array(16))),
    };
    options.socket.send(JSON.stringify(desktopHello));
  };

  const handleSocketStatus = (status: RelaySocketStatus): void => {
    if (status === 'open') beginHandshake();
    if (status === 'connecting' || status === 'reconnecting' || status === 'closed') {
      generation += 1;
      authenticated = false;
      keys = null;
    }
  };

  const handleRaw = async (raw: string): Promise<void> => {
    const currentGeneration = generation;
    const isCurrent = (): boolean => !closed && generation === currentGeneration;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      fail('authentication-failed', 'invalid_message');
      return;
    }

    if (isHello(message)) {
      if (message.version !== MOBILE_REMOTE_PROTOCOL_VERSION) {
        fail('protocol-mismatch', 'protocol_mismatch');
        return;
      }
      if (
        message.role !== 'phone' ||
        message.connectionId !== options.pairing.roomId ||
        !desktopHello
      ) {
        fail('authentication-failed', 'invalid_hello');
        return;
      }
      if (phoneHello?.nonce === message.nonce && keys) return;
      phoneHello = message;
      const derivedKeys = await deriveSessionKeys({
        ...options.pairing,
        desktopNonce: desktopHello.nonce,
        phoneNonce: phoneHello.nonce,
        role: 'desktop',
      });
      if (!isCurrent()) return;
      keys = derivedKeys;
      const proof = await createHandshakeProof(
        options.pairing.secret,
        handshakeTranscript(desktopHello, phoneHello, 'desktop'),
      );
      if (!isCurrent()) return;
      // The relay does not buffer frames when the other role is absent. Re-send
      // our hello now that the phone has proved it is connected, before proof.
      options.socket.send(JSON.stringify(desktopHello));
      options.socket.send(
        JSON.stringify({
          type: 'handshake.proof',
          connectionId: options.pairing.roomId,
          proof,
        } satisfies HandshakeProof),
      );
      return;
    }

    if (isProof(message)) {
      if (
        !desktopHello ||
        !phoneHello ||
        !keys ||
        message.connectionId !== options.pairing.roomId
      ) {
        fail('authentication-failed', 'unexpected_proof');
        return;
      }
      const expected = await createHandshakeProof(
        options.pairing.secret,
        handshakeTranscript(desktopHello, phoneHello, 'phone'),
      );
      if (!isCurrent()) return;
      if (message.proof !== expected) {
        fail('authentication-failed', 'invalid_proof');
        return;
      }
      authenticated = true;
      options.socket.send(JSON.stringify({ type: 'relay.authenticated' }));
      options.onAuthenticated?.();
      return;
    }

    if (!isEnvelope(message) || !authenticated || !keys) {
      fail('authentication-failed', 'proof_required');
      return;
    }
    try {
      const plaintext = await openEnvelope(keys.receive, message);
      if (!isCurrent()) return;
      await options.handleMessage(peer, textDecoder.decode(plaintext));
    } catch {
      fail('authentication-failed', 'invalid_frame');
    }
  };

  const peer: EncryptedPeer = {
    subscribedSid: null,
    get authenticated() {
      return authenticated;
    },
    start() {
      if (started || closed) return;
      started = true;
      offMessage = options.socket.onMessage((raw) => {
        incomingMessages = incomingMessages
          .then(() => handleRaw(raw))
          .catch(() => fail('authentication-failed', 'invalid_message'));
      });
      offStatus = options.socket.onStatus(handleSocketStatus);
      options.socket.connect();
    },
    send(payload) {
      if (!authenticated || !keys || closed) return;
      const currentGeneration = generation;
      outgoingMessages = outgoingMessages
        .then(async () => {
          if (!authenticated || !keys || closed || generation !== currentGeneration) return;
          const envelope = await sealEnvelope(
            keys.send,
            textEncoder.encode(JSON.stringify(payload)),
          );
          if (!authenticated || closed || generation !== currentGeneration) return;
          options.socket.send(JSON.stringify(envelope));
        })
        .catch(() => fail('authentication-failed', 'encryption_failed'));
    },
    close() {
      closed = true;
      generation += 1;
      authenticated = false;
      keys = null;
      offMessage?.();
      offStatus?.();
      options.socket.close();
    },
  };

  return peer;
}
