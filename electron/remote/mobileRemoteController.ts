// electron/remote/mobileRemoteController.ts
import { type RTCIceServer } from 'werift';
import { createDesktopPeer } from './desktopPeer';
import { createDoSignalingClient } from './doSignalingClient';
import { readMobileRemoteLogin, type TokenProvider } from './tokenProvider';
import type { PeerClient } from './peerClient';
import type { SignalingClient } from './signaling';

/** Component E (detail spec §1.2-E): the desktop entry point for the
 *  public-internet mobile path. Reads login state via the injected token
 *  provider (PR-4 minimal env impl; PR-4b real OAuth), builds the Durable
 *  Object wss URL, constructs the DO signaling client + desktop WebRTC
 *  answerer, and returns a disposer. Returns null when not logged in / feature
 *  off — main.ts treats null exactly like the old server returning null. The
 *  signaling/peer factories are injected so this is unit-testable without a
 *  network or werift, and the loopback e2e can substitute an in-process
 *  bridge. */
export function startMobileRemote(opts?: {
  tokenProvider?: TokenProvider;
  iceServers?: RTCIceServer[];
  createSignaling?: (o: { url: string; peerId: string }) => SignalingClient;
  createPeer?: (o: {
    iceServers: RTCIceServer[];
    signaling: SignalingClient;
    clients: Set<PeerClient>;
  }) => { close: () => void };
}): { close: () => void } | null {
  const tokenProvider = opts?.tokenProvider ?? readMobileRemoteLogin;
  const login = tokenProvider();
  if (!login) return null;

  const peerId = `desktop-${Math.random().toString(36).slice(2, 10)}`;
  const url = `${login.doUrl}?token=${encodeURIComponent(login.token)}`;
  const iceServers = opts?.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];

  const createSignaling =
    opts?.createSignaling ?? ((o) => createDoSignalingClient({ url: o.url, peerId: o.peerId }));
  const createPeer = opts?.createPeer ?? createDesktopPeer;

  const signaling = createSignaling({ url, peerId });
  const clients = new Set<PeerClient>();
  const peer = createPeer({ iceServers, signaling, clients });

  return { close: () => peer.close() };
}
