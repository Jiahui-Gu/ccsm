// src/mobile/protocol.ts
/** Phone-side mirror of the on-the-wire message shapes. CLAUDE.md forbids
 *  src/ importing electron/, so these are RE-DECLARED here and must stay
 *  structurally identical to their authorities:
 *   - terminal messages  ↔ electron/remote/remoteMessages.ts
 *   - signaling messages ↔ PR-1 Durable Object schema, pr1-cloudflare-detail
 *     §6.3, and electron/remote/signaling.ts (PR-2 desktop side).
 *  Any drift here is a wire-incompatibility bug. */

// ---- terminal protocol (DataChannel payloads, detail spec §6) ----

export type SessionListEntry = { sid: string; cwd: string; cols: number; rows: number };

export type PhoneToDesktop =
  | { type: 'sessions.list' }
  | { type: 'session.snapshot'; sid: string }
  | { type: 'session.input'; sid: string; data: string }
  | { type: 'session.resize'; sid: string; cols: number; rows: number };

export type DesktopToPhone =
  | { type: 'sessions.list'; sessions: SessionListEntry[] }
  | { type: 'session.snapshot'; sid: string; cols: number | null; rows: number | null; snapshot: string; seq: number }
  | { type: 'pty.data'; sid: string; chunk: string; seq: number }
  | { type: 'error'; message: string };

// ---- signaling protocol (DO WebSocket, detail spec §3, PR-1 §6.3) ----

export type SignalRole = 'desktop' | 'phone';

export type SignalRegister = { type: 'register'; role: SignalRole; peerId: string };
export type SignalOffer = { type: 'offer'; to: string; from: string; sdp: string };
export type SignalAnswer = { type: 'answer'; to: string; from: string; sdp: string };
export type SignalIce = {
  type: 'ice';
  to: string;
  from: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
};

export type SignalRegistered = { type: 'registered'; peerId: string; peers: { role: SignalRole; peerId: string }[] };
export type SignalPeerPresent = { type: 'peer-present'; role: SignalRole; peerId: string };
export type SignalPeerGone = { type: 'peer-gone'; role: SignalRole; peerId: string };
export type SignalError = { type: 'error'; code: string; message: string };

export type SignalInbound =
  | SignalRegistered
  | SignalPeerPresent
  | SignalPeerGone
  | SignalOffer
  | SignalAnswer
  | SignalIce
  | SignalError;
