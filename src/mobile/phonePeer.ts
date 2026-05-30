// src/mobile/phonePeer.ts
import type { DesktopToPhone, PhoneToDesktop } from './protocol';
import type { SignalCandidate, SignalDescription } from './phoneSignaling';

type PhoneSignaling = {
  onPeerPresent: (cb: (desktopPeerId: string) => void) => void;
  onAnswer: (cb: (answer: SignalDescription, from: string) => void) => void;
  onRemoteIce: (cb: (cand: SignalCandidate, from: string) => void) => void;
  sendOffer: (offer: SignalDescription, to: string) => void;
  sendIce: (cand: SignalCandidate, to: string) => void;
  close: () => void;
};

/** Phone WebRTC offerer. Symmetric to the desktop answerer (desktopPeer.ts):
 *  the phone CREATES the `terminal` DataChannel and the offer, the desktop
 *  answers. Browser RTCPeerConnection is injected so this is unit-testable in
 *  plain Node (detail spec §1.3-F, §2). Terminal payloads on the channel are
 *  the unchanged protocol (§6). */
export function createPhonePeer(opts: {
  iceServers: RTCIceServer[];
  signaling: PhoneSignaling;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}): {
  send: (msg: PhoneToDesktop) => void;
  onMessage: (cb: (msg: DesktopToPhone) => void) => void;
  onOpen: (cb: () => void) => void;
  close: () => void;
} {
  const { signaling } = opts;
  const make = opts.createPeerConnection ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
  const pc = make({ iceServers: opts.iceServers });
  const channel = pc.createDataChannel('terminal');

  let desktopPeerId: string | null = null;
  let messageCb: ((msg: DesktopToPhone) => void) | null = null;
  let openCb: (() => void) | null = null;

  channel.onopen = () => openCb?.();
  channel.onmessage = (ev: MessageEvent) => {
    let msg: DesktopToPhone;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    messageCb?.(msg);
  };

  pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
    const c = ev.candidate;
    // null candidate = end-of-candidates; nothing to forward.
    if (!c || !desktopPeerId) return;
    signaling.sendIce(
      { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null },
      desktopPeerId,
    );
  };

  signaling.onPeerPresent(async (id) => {
    desktopPeerId = id;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendOffer({ sdp: offer.sdp ?? '' }, id);
  });

  signaling.onAnswer(async (answer) => {
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  });

  signaling.onRemoteIce(async (cand) => {
    try {
      await pc.addIceCandidate({
        candidate: cand.candidate,
        sdpMid: cand.sdpMid ?? undefined,
        sdpMLineIndex: cand.sdpMLineIndex ?? undefined,
      });
    } catch { /* candidate may arrive before remoteDescription; browser retries */ }
  });

  return {
    send: (msg: PhoneToDesktop) => {
      if (channel.readyState === 'open') channel.send(JSON.stringify(msg));
    },
    onMessage: (cb) => { messageCb = cb; },
    onOpen: (cb) => { openCb = cb; },
    close: () => {
      signaling.close();
      try { pc.close(); } catch { /* already closed */ }
    },
  };
}
