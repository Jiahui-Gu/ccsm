import { describe, expect, it, vi, beforeEach } from 'vitest';

// Lightweight fake RTCPeerConnection: records addIceCandidate calls per instance
// and exposes only the surface createDesktopPeer touches. No real ICE/SCTP, so
// this routing test is deterministic and runs in any environment. The class is
// declared inside the (hoisted) vi.mock factory to satisfy hoisting rules; the
// constructor pushes each instance onto a shared registry we read back below.
const pcInstances = vi.hoisted(() => [] as FakePeerConnectionShape[]);
type FakePeerConnectionShape = {
  iceCandidates: unknown[];
  onIceCandidate: { subscribe: (cb: (c: unknown) => void) => void };
  onDataChannel: { subscribe: (cb: (c: unknown) => void) => void };
  addIceCandidate: (cand: unknown) => Promise<void>;
};

vi.mock('werift', () => {
  class FakePeerConnection {
    iceCandidates: unknown[] = [];
    onIceCandidate = { subscribe: (_cb: (c: unknown) => void) => {} };
    onDataChannel = { subscribe: (_cb: (c: unknown) => void) => {} };
    constructor() { pcInstances.push(this as unknown as FakePeerConnectionShape); }
    async setRemoteDescription() {}
    async createAnswer() { return { sdp: 'answer-sdp' }; }
    async setLocalDescription() {}
    async addIceCandidate(cand: unknown) { this.iceCandidates.push(cand); }
    close() {}
  }
  return { RTCPeerConnection: FakePeerConnection };
});
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [],
  getBufferSnapshot: async () => ({ data: '', seq: 0 }),
  getPtySession: () => null,
  inputPtySession: () => {},
  resizePtySession: () => {},
  onPtyData: () => () => {},
}));

import { createDesktopPeer } from '../desktopPeer';
import type { SignalingClient, SignalDescription, SignalCandidate } from '../signaling';

describe('createDesktopPeer ICE routing by peerId', () => {
  let onOfferCb: ((o: SignalDescription, p: string) => void) | null;
  let onIceCb: ((c: SignalCandidate, p: string) => void) | null;

  beforeEach(() => {
    pcInstances.length = 0;
    onOfferCb = null;
    onIceCb = null;
  });

  function makeSignaling(): SignalingClient {
    return {
      onOffer: (cb) => { onOfferCb = cb; },
      onRemoteIce: (cb) => { onIceCb = cb; },
      sendAnswer: () => {},
      sendIce: () => {},
      close: () => {},
    };
  }

  it('routes a candidate only to the addressed peer and drops unknown peers', async () => {
    const signaling = makeSignaling();
    createDesktopPeer({ iceServers: [], signaling, clients: new Set() });

    await onOfferCb?.({ type: 'offer', sdp: 'a' }, 'phoneA');
    await onOfferCb?.({ type: 'offer', sdp: 'b' }, 'phoneB');
    expect(pcInstances).toHaveLength(2);
    const [pcA, pcB] = pcInstances;

    const candX: SignalCandidate = { candidate: 'cand-x', sdpMid: '0', sdpMLineIndex: 0 };
    await onIceCb?.(candX, 'phoneB');

    expect(pcB.iceCandidates).toHaveLength(1);
    expect(pcA.iceCandidates).toHaveLength(0);

    // A candidate addressed to an unknown peer is silently dropped (no throw).
    const candY: SignalCandidate = { candidate: 'cand-y', sdpMid: '0', sdpMLineIndex: 0 };
    await expect(onIceCb?.(candY, 'unknown-peer')).resolves.toBeUndefined();
    expect(pcA.iceCandidates).toHaveLength(0);
    expect(pcB.iceCandidates).toHaveLength(1);
  });
});
