// electron/remote/doSignalingClient.ts
import type { SignalCandidate, SignalDescription, SignalingClient } from './signaling';

/** The desktop (answerer) side of the Durable Object signaling protocol. The
 *  exact inverted mirror of src/mobile/phoneSignaling.ts: the desktop SENDS
 *  register{role:'desktop'} + answer + ice and RECEIVES offer + ice. The
 *  WebSocket is injected so tests fake it; the real
 *  `wss://<worker>/do/<userHash>?token=<jwt>` URL is built by the caller
 *  (mobileRemoteController). CLAUDE.md forbids src/ importing electron/, so the
 *  phone mirror re-declares these shapes in src/mobile/protocol.ts — keep the
 *  two structurally identical (detail spec §3, PR-1 §6.3). */
type DoInbound =
  | { type: 'registered'; peerId: string; peers: { role: 'desktop' | 'phone'; peerId: string }[] }
  | { type: 'peer-present'; role: 'desktop' | 'phone'; peerId: string }
  | { type: 'peer-gone'; role: 'desktop' | 'phone'; peerId: string }
  | { type: 'offer'; to: string; from: string; sdp: string }
  | { type: 'ice'; to: string; from: string; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { type: 'error'; code: string; message: string };

export function createDoSignalingClient(opts: {
  url: string;
  peerId: string;
  createWebSocket?: (url: string) => WebSocket;
}): SignalingClient {
  const make = opts.createWebSocket ?? ((u: string) => new WebSocket(u));
  const ws = make(opts.url);

  let offerCb: ((offer: SignalDescription, peerId: string) => void) | null = null;
  let iceCb: ((cand: SignalCandidate, peerId: string) => void) | null = null;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register', role: 'desktop', peerId: opts.peerId }));
  };

  ws.onmessage = (ev: { data: unknown }) => {
    let msg: DoInbound;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    switch (msg.type) {
      case 'offer':
        offerCb?.({ type: 'offer', sdp: msg.sdp }, msg.from);
        return;
      case 'ice':
        iceCb?.({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex }, msg.from);
        return;
      default:
        return;
    }
  };

  return {
    onOffer: (cb) => { offerCb = cb; },
    onRemoteIce: (cb) => { iceCb = cb; },
    sendAnswer: (answer, peerId) => {
      ws.send(JSON.stringify({ type: 'answer', to: peerId, from: opts.peerId, sdp: answer.sdp }));
    },
    sendIce: (cand, peerId) => {
      ws.send(JSON.stringify({
        type: 'ice', to: peerId, from: opts.peerId,
        candidate: cand.candidate, sdpMid: cand.sdpMid ?? null, sdpMLineIndex: cand.sdpMLineIndex ?? null,
      }));
    },
    close: () => { try { ws.close(); } catch { /* already closed */ } },
  };
}
