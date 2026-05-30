// src/mobile/phoneSignaling.ts
import type { SignalInbound, SignalRegister, SignalOffer, SignalIce } from './protocol';

export type SignalDescription = { sdp: string };
export type SignalCandidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

/** The phone (offerer) side of the Durable Object signaling protocol. Mirrors
 *  the desktop SignalingClient (PR-2) but inverted: the phone SENDS offer/ice
 *  and RECEIVES answer/ice. The WebSocket is injected so tests fake it and the
 *  real `wss://<host>/do/<userHash>?token=<jwt>` URL is built by the caller
 *  (detail spec §3, PR-1 §6.3). */
export function createPhoneSignaling(opts: {
  url: string;
  peerId: string;
  createWebSocket?: (url: string) => WebSocket;
}) {
  const make = opts.createWebSocket ?? ((u: string) => new WebSocket(u));
  const ws = make(opts.url);

  let peerCb: ((desktopPeerId: string) => void) | null = null;
  let answerCb: ((answer: SignalDescription, from: string) => void) | null = null;
  let iceCb: ((cand: SignalCandidate, from: string) => void) | null = null;

  ws.onopen = () => {
    const reg: SignalRegister = { type: 'register', role: 'phone', peerId: opts.peerId };
    ws.send(JSON.stringify(reg));
  };

  ws.onmessage = (ev: { data: unknown }) => {
    let msg: SignalInbound;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    switch (msg.type) {
      case 'registered':
        for (const p of msg.peers) if (p.role === 'desktop') peerCb?.(p.peerId);
        return;
      case 'peer-present':
        if (msg.role === 'desktop') peerCb?.(msg.peerId);
        return;
      case 'answer':
        answerCb?.({ sdp: msg.sdp }, msg.from);
        return;
      case 'ice':
        iceCb?.({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex }, msg.from);
        return;
      default:
        return;
    }
  };

  return {
    onPeerPresent: (cb: (desktopPeerId: string) => void) => { peerCb = cb; },
    onAnswer: (cb: (answer: SignalDescription, from: string) => void) => { answerCb = cb; },
    onRemoteIce: (cb: (cand: SignalCandidate, from: string) => void) => { iceCb = cb; },
    sendOffer: (offer: SignalDescription, to: string) => {
      const m: SignalOffer = { type: 'offer', to, from: opts.peerId, sdp: offer.sdp };
      ws.send(JSON.stringify(m));
    },
    sendIce: (cand: SignalCandidate, to: string) => {
      const m: SignalIce = {
        type: 'ice', to, from: opts.peerId,
        candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex,
      };
      ws.send(JSON.stringify(m));
    },
    close: () => { try { ws.close(); } catch { /* already closed */ } },
  };
}
