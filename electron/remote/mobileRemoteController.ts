import type { PairingIdentity } from '../../src/shared/mobileRemote';
import { createEncryptedPeer, type EncryptedPeer } from './encryptedPeer';
import { createPairingStore, type PairingStore } from './pairingStore';
import { installPtyFanout } from './ptyFanout';
import { handleClientMessage, sendSessionCatalog } from './remoteMessages';
import type { RemotePeer } from './remotePeer';
import { resolveRelayUrl } from './relayConfig';
import {
  createRelaySocket,
  type RelaySocket,
  type RelaySocketOptions,
} from './relaySocket';

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
  handleMessage?: (peer: RemotePeer, raw: string) => Promise<void> | void;
};

export async function createMobileRemoteController(
  options: ControllerOptions = {},
): Promise<MobileRemoteController> {
  const relayUrl = options.relayUrl === undefined ? resolveRelayUrl() : options.relayUrl;
  const store = options.pairingStore ?? createPairingStore();
  const socketFactory = options.createSocket ?? createRelaySocket;
  const clientMessageHandler = options.handleMessage ?? handleClientMessage;
  const handlers = new Set<(status: MobileRemoteStatus) => void>();
  const peers = new Set<RemotePeer>();
  const offPtyData = installPtyFanout(peers);
  let status: MobileRemoteStatus = relayUrl
    ? { kind: 'connecting' }
    : { kind: 'unavailable', reason: 'relay-not-configured' };
  let pairing: PairingIdentity | null = null;
  let socket: RelaySocket | null = null;
  let peer: EncryptedPeer | null = null;
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
    if (peer) peers.delete(peer);
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
    peer = createEncryptedPeer({
      pairing,
      socket: currentSocket,
      handleMessage: clientMessageHandler,
      onAuthenticated: () => {
        setStatus({ kind: 'ready', phoneConnected: true });
        if (peer) sendSessionCatalog(peer);
      },
      onFailure: (reason) => setStatus({ kind: 'error', reason }),
    });
    peers.add(peer);
    offSocketStatus = currentSocket.onStatus((socketStatus) => {
      if (socketStatus === 'unreachable') {
        setStatus({ kind: 'error', reason: 'relay-unreachable' });
      } else if (socketStatus === 'connecting' || socketStatus === 'reconnecting') {
        setStatus({ kind: 'connecting' });
      } else if (socketStatus === 'open') {
        setStatus({ kind: 'ready', phoneConnected: false });
      }
    });
    peer.start();
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
      offPtyData();
      handlers.clear();
    },
  };
}
