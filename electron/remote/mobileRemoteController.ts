// electron/remote/mobileRemoteController.ts
import { type RTCIceServer } from 'werift';
import { createDesktopPeer } from './desktopPeer';
import { createDoSignalingClient } from './doSignalingClient';
import { readMobileRemoteLogin, type TokenProvider } from './tokenProvider';
import { fetchIceServers } from './turnCred';
import type { PeerClient } from './peerClient';
import type { SignalingClient } from './signaling';

const GOOGLE_STUN: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Component E (detail spec §1.2-E): the desktop entry point for the
 *  public-internet mobile path. Reads login state via the injected token
 *  provider, resolves ICE servers (PR-5: injected > Worker `/turn/credentials`
 *  > Google-STUN fallback), builds the Durable Object wss URL, constructs the
 *  DO signaling client + desktop WebRTC answerer, and returns a disposer.
 *  Returns null when not logged in / feature off — main.ts treats null exactly
 *  like the old server returning null. The signaling/peer/ICE factories are
 *  injected so this is unit-testable without a network or werift, and the
 *  loopback e2e can substitute an in-process bridge. */
export async function startMobileRemote(opts?: {
  tokenProvider?: TokenProvider;
  workerOrigin?: string;
  iceServers?: RTCIceServer[];
  fetchIce?: typeof fetchIceServers;
  createSignaling?: (o: { url: string; peerId: string }) => SignalingClient;
  createPeer?: (o: {
    iceServers: RTCIceServer[];
    signaling: SignalingClient;
    clients: Set<PeerClient>;
  }) => { close: () => void };
}): Promise<{ close: () => void } | null> {
  const tokenProvider = opts?.tokenProvider ?? readMobileRemoteLogin;
  const login = tokenProvider();
  if (!login) return null;

  const peerId = `desktop-${Math.random().toString(36).slice(2, 10)}`;
  const url = `${login.doUrl}?token=${encodeURIComponent(login.token)}`;

  const iceServers = await resolveIceServers(opts, login.token);

  const createSignaling =
    opts?.createSignaling ?? ((o) => createDoSignalingClient({ url: o.url, peerId: o.peerId }));
  const createPeer = opts?.createPeer ?? createDesktopPeer;

  const signaling = createSignaling({ url, peerId });
  const clients = new Set<PeerClient>();
  const peer = createPeer({ iceServers, signaling, clients });

  return { close: () => peer.close() };
}

async function resolveIceServers(
  opts: { workerOrigin?: string; iceServers?: RTCIceServer[]; fetchIce?: typeof fetchIceServers } | undefined,
  token: string,
): Promise<RTCIceServer[]> {
  if (opts?.iceServers) return opts.iceServers;
  if (opts?.workerOrigin) {
    const fetchIce = opts.fetchIce ?? fetchIceServers;
    const fetched = await fetchIce({ workerOrigin: opts.workerOrigin, token });
    if (fetched && fetched.length > 0) return fetched;
  }
  return GOOGLE_STUN;
}
