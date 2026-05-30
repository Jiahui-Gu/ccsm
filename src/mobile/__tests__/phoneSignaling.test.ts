// src/mobile/__tests__/phoneSignaling.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPhoneSignaling } from '../phoneSignaling';
import type { SignalInbound } from '../protocol';

/** Minimal WebSocket fake: records sent frames, lets the test push inbound. */
class FakeWs {
  static OPEN = 1;
  readyState = FakeWs.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(s: string) { this.sent.push(s); }
  close() { this.onclose?.(); }
  // test helpers
  fireOpen() { this.onopen?.(); }
  push(msg: SignalInbound) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  lastJson() { return JSON.parse(this.sent[this.sent.length - 1]!); }
}

function setup() {
  const ws = new FakeWs();
  const sig = createPhoneSignaling({
    url: 'wss://ccsm-worker.example.workers.dev/do/HASH?token=JWT',
    peerId: 'p1',
    createWebSocket: () => ws as unknown as WebSocket,
  });
  return { ws, sig };
}

describe('createPhoneSignaling', () => {
  it('registers as phone on open', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    expect(ws.lastJson()).toEqual({ type: 'register', role: 'phone', peerId: 'p1' });
    sig.close();
  });

  it('reports the desktop peer from registered.peers and peer-present', () => {
    const { ws, sig } = setup();
    const onPeer = vi.fn();
    sig.onPeerPresent(onPeer);
    ws.fireOpen();
    ws.push({ type: 'registered', peerId: 'p1', peers: [{ role: 'desktop', peerId: 'd1' }] });
    expect(onPeer).toHaveBeenCalledWith('d1');
    ws.push({ type: 'peer-present', role: 'desktop', peerId: 'd2' });
    expect(onPeer).toHaveBeenCalledWith('d2');
    sig.close();
  });

  it('ignores a phone peer in registered/peer-present (only desktop matters)', () => {
    const { ws, sig } = setup();
    const onPeer = vi.fn();
    sig.onPeerPresent(onPeer);
    ws.fireOpen();
    ws.push({ type: 'registered', peerId: 'p1', peers: [{ role: 'phone', peerId: 'pX' }] });
    ws.push({ type: 'peer-present', role: 'phone', peerId: 'pY' });
    expect(onPeer).not.toHaveBeenCalled();
    sig.close();
  });

  it('sendOffer / sendIce frame to the desktop peerId with from=self', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    sig.sendOffer({ sdp: 'v=0-offer' }, 'd1');
    expect(ws.lastJson()).toEqual({ type: 'offer', to: 'd1', from: 'p1', sdp: 'v=0-offer' });
    sig.sendIce({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 }, 'd1');
    expect(ws.lastJson()).toEqual({
      type: 'ice', to: 'd1', from: 'p1', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0,
    });
    sig.close();
  });

  it('routes inbound answer and ice to callbacks', () => {
    const { ws, sig } = setup();
    const onAnswer = vi.fn();
    const onIce = vi.fn();
    sig.onAnswer(onAnswer);
    sig.onRemoteIce(onIce);
    ws.fireOpen();
    ws.push({ type: 'answer', to: 'p1', from: 'd1', sdp: 'v=0-answer' });
    expect(onAnswer).toHaveBeenCalledWith({ sdp: 'v=0-answer' }, 'd1');
    ws.push({ type: 'ice', to: 'p1', from: 'd1', candidate: 'c2', sdpMid: '0', sdpMLineIndex: 1 });
    expect(onIce).toHaveBeenCalledWith({ candidate: 'c2', sdpMid: '0', sdpMLineIndex: 1 }, 'd1');
    sig.close();
  });
});
