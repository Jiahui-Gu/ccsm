import { RTCPeerConnection, type RTCIceServer } from 'werift';
import { onPtyData } from '../ptyHost';
import { handleClientMessage, listEntries } from './remoteMessages';
import { fanoutPtyData } from './ptyFanout';
import type { PeerClient } from './peerClient';
import type { SignalCandidate, SignalingClient } from './signaling';

/** Builds the desktop WebRTC answerer: it accepts a phone's offer via the
 *  injected signaling transport, opens the `terminal` DataChannel, and runs the
 *  EXISTING terminal protocol (`handleClientMessage` + pty.data fan-out) over
 *  that channel. The DataChannel replaces the WebSocket; the protocol core is
 *  untouched (detail spec §1.2-D, §6). `clients` is the shared peer set the
 *  pty.data fan-out iterates — owned by the caller so multiple phones can be
 *  tracked together (detail spec §5.7). */
export function createDesktopPeer(opts: {
  iceServers: RTCIceServer[];
  signaling: SignalingClient;
  clients: Set<PeerClient>;
}): { close: () => void } {
  const { signaling, clients } = opts;
  const pcs = new Map<string, RTCPeerConnection>();

  const offPtyData = onPtyData((sid, chunk, seq) => {
    fanoutPtyData(clients, sid, chunk, seq);
  });

  signaling.onOffer(async (offer, peerId) => {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    pcs.set(peerId, pc);

    pc.onIceCandidate.subscribe((cand) => {
      // werift hands us its own RTCIceCandidate; forward only the plain wire
      // fields the SignalCandidate contract carries (candidate/sdpMid/
      // sdpMLineIndex). The signaling transport must not depend on werift's
      // class shape.
      if (!cand) return;
      const wire: SignalCandidate = {
        candidate: cand.candidate,
        sdpMid: cand.sdpMid ?? null,
        sdpMLineIndex: cand.sdpMLineIndex ?? null,
      };
      signaling.sendIce(wire, peerId);
    });

    pc.onDataChannel.subscribe((channel) => {
      if (channel.label !== 'terminal') return;
      const client: PeerClient = {
        subscribedSid: null,
        send: (payload) => {
          if (channel.readyState === 'open') channel.send(JSON.stringify(payload));
        },
      };
      channel.onMessage.subscribe((msg) => {
        const raw = typeof msg === 'string' ? msg : msg.toString();
        void handleClientMessage(client, raw);
      });
      // The phone learns the session list as soon as the channel opens, same as
      // the WS server's initial push (mobileRemoteServer.ts). auth.ok is gone —
      // auth happened at the signaling/GitHub layer (detail spec §6).
      const pushList = () => client.send({ type: 'sessions.list', sessions: listEntries() });
      if (channel.readyState === 'open') pushList();
      else channel.stateChanged.subscribe((s) => { if (s === 'open') pushList(); });
      clients.add(client);

      const drop = () => clients.delete(client);
      channel.stateChanged.subscribe((s) => { if (s === 'closed') drop(); });
    });

    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signaling.sendAnswer({ type: 'answer', sdp: answer.sdp }, peerId);
  });

  signaling.onRemoteIce(async (cand, peerId) => {
    // Route each candidate to ONLY the pc that owns its peerId. Fanning every
    // candidate to all pcs leaks one phone's candidates into another's
    // connection (cross-peer isolation bug) once more than one phone connects.
    // A candidate for an unknown peer is silently dropped.
    const pc = pcs.get(peerId);
    if (!pc) return;
    try {
      await pc.addIceCandidate({
        candidate: cand.candidate,
        sdpMid: cand.sdpMid ?? undefined,
        sdpMLineIndex: cand.sdpMLineIndex ?? undefined,
      });
    } catch {
      /* candidate may still be invalid; ignore */
    }
  });

  return {
    close: () => {
      offPtyData();
      signaling.close();
      for (const pc of pcs.values()) void pc.close();
      pcs.clear();
      clients.clear();
    },
  };
}
