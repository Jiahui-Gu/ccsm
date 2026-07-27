import type { BrowserWindow } from 'electron';

import type { PairingIdentity } from '../../src/shared/mobileRemote';
import { parseMirrorClientMessage } from '../../src/shared/mobileRemote';
import { createEncryptedPeer, type EncryptedPeer } from './encryptedPeer';
import { createPairingStore, type PairingStore } from './pairingStore';
import { resolveRelayUrl } from './relayConfig';
import {
  createRelaySocket,
  type RelaySocket,
  type RelaySocketOptions,
} from './relaySocket';
import { createWindowMirror, type WindowMirror } from './windowMirror';

export type MobileRemoteStatus =
  | {
      kind: 'unavailable';
      reason: 'relay-not-configured' | 'secure-storage-unavailable';
    }
  | { kind: 'connecting' }
  | { kind: 'ready'; phoneConnected: false }
  | { kind: 'ready'; phoneConnected: true }
  | { kind: 'paused' }
  | {
      kind: 'error';
      reason: 'relay-unreachable' | 'protocol-mismatch' | 'authentication-failed';
    };

export interface MobileRemoteController {
  getStatus(): MobileRemoteStatus;
  getPairingUrl(): string | null;
  pause(): void;
  resume(): void;
  rotate(): Promise<void>;
  subscribe(handler: (status: MobileRemoteStatus) => void): () => void;
  close(): void;
}

type ControllerOptions = {
  relayUrl?: string | null;
  pairingStore?: PairingStore;
  createSocket?: (options: RelaySocketOptions) => RelaySocket;
  getWindow?: () => BrowserWindow | null;
};

export async function createMobileRemoteController(
  options: ControllerOptions = {},
): Promise<MobileRemoteController> {
  const relayUrl = options.relayUrl === undefined ? resolveRelayUrl() : options.relayUrl;
  const store = options.pairingStore ?? createPairingStore();
  const socketFactory = options.createSocket ?? createRelaySocket;
  const getWindow = options.getWindow ?? (() => null);
  const handlers = new Set<(status: MobileRemoteStatus) => void>();
  let status: MobileRemoteStatus = relayUrl
    ? { kind: 'connecting' }
    : { kind: 'unavailable', reason: 'relay-not-configured' };
  let pairing: PairingIdentity | null = null;
  let socket: RelaySocket | null = null;
  let peer: EncryptedPeer | null = null;
  let mirror: WindowMirror | null = null;
  let offSocketStatus: (() => void) | null = null;
  let paused = false;
  let closed = false;
  let rotating = false;
  let rotation = Promise.resolve();

  const setStatus = (next: MobileRemoteStatus): void => {
    status = next;
    for (const handler of handlers) handler(next);
  };

  const disconnect = (): void => {
    offSocketStatus?.();
    offSocketStatus = null;
    mirror?.stop();
    mirror = null;
    peer?.close();
    peer = null;
    socket = null;
  };

  const connect = (): void => {
    if (!relayUrl || !pairing || paused || closed || rotating) return;
    disconnect();
    setStatus({ kind: 'connecting' });
    socket = socketFactory({ relayUrl, roomId: pairing.roomId });
    const currentSocket = socket;
    let currentPeer: EncryptedPeer | null = null;
    const currentMirror = createWindowMirror({
      getWindow,
      send: (message) => currentPeer?.send(message),
    });
    currentPeer = createEncryptedPeer({
      pairing,
      socket: currentSocket,
      handleMessage: (remotePeer, raw) => {
        const message = parseMirrorClientMessage(raw);
        if (!message) {
          remotePeer.send({ type: 'mirror.error', message: 'invalid_message' });
          return;
        }
        currentMirror.handle(message);
      },
      onAuthenticated: () => {
        setStatus({ kind: 'ready', phoneConnected: true });
      },
      onFailure: (reason) => setStatus({ kind: 'error', reason }),
    });
    peer = currentPeer;
    mirror = currentMirror;
    offSocketStatus = currentSocket.onStatus((socketStatus) => {
      if (socketStatus === 'unreachable') {
        currentMirror.stop();
        setStatus({ kind: 'error', reason: 'relay-unreachable' });
      } else if (socketStatus === 'connecting' || socketStatus === 'reconnecting') {
        currentMirror.stop();
        setStatus({ kind: 'connecting' });
      } else if (socketStatus === 'open') {
        currentMirror.stop();
        setStatus({ kind: 'ready', phoneConnected: false });
      }
    });
    currentPeer.start();
  };

  if (relayUrl) {
    pairing = await store.loadOrCreate();
    if (!pairing) {
      setStatus({ kind: 'unavailable', reason: 'secure-storage-unavailable' });
    } else {
      connect();
    }
  }

  return {
    getStatus: () => status,
    getPairingUrl() {
      if (!relayUrl || !pairing) return null;
      return `${relayUrl}/#pair=${pairing.roomId}.${pairing.secret}`;
    },
    pause() {
      if (closed || paused) return;
      paused = true;
      disconnect();
      setStatus({ kind: 'paused' });
    },
    resume() {
      if (closed || !paused) return;
      paused = false;
      connect();
    },
    rotate() {
      const rotatePairing = async (): Promise<void> => {
        if (closed || !relayUrl) return;
        rotating = true;
        try {
          disconnect();
          pairing = null;
          await store.delete();
          pairing = await store.loadOrCreate();
          if (!pairing) {
            setStatus({ kind: 'unavailable', reason: 'secure-storage-unavailable' });
            return;
          }
        } catch {
          setStatus({ kind: 'unavailable', reason: 'secure-storage-unavailable' });
          return;
        } finally {
          rotating = false;
        }
        if (!paused) connect();
      };
      rotation = rotation.then(rotatePairing, rotatePairing);
      return rotation;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      disconnect();
      handlers.clear();
    },
  };
}
