/** WebRTC signaling is the out-of-band exchange of SDP offer/answer and ICE
 *  candidates that lets two peers find each other. In production this rides a
 *  Cloudflare Durable Object WebSocket (detail spec §3); here we depend only on
 *  this interface so the desktop peer is testable with an in-memory fake and
 *  the real transport lands in a later PR without touching peer logic. */
export type SignalDescription = { type: 'offer' | 'answer'; sdp: string };
export type SignalCandidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

export type SignalingClient = {
  /** Desktop is the answerer: it is handed the phone's offer. */
  onOffer: (cb: (offer: SignalDescription, peerId: string) => void) => void;
  onRemoteIce: (cb: (cand: SignalCandidate, peerId: string) => void) => void;
  sendAnswer: (answer: SignalDescription, peerId: string) => void;
  sendIce: (cand: SignalCandidate, peerId: string) => void;
  close: () => void;
};
