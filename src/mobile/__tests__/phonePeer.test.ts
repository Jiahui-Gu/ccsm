// src/mobile/__tests__/phonePeer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPhonePeer } from '../phonePeer';
import type { DesktopToPhone } from '../protocol';

/** Fake RTCDataChannel: records sent frames, lets the test push inbound + open. */
class FakeChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(s: string) { this.sent.push(s); }
  fireOpen() { this.readyState = 'open'; this.onopen?.(); }
  push(msg: DesktopToPhone) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

/** Fake RTCPeerConnection capturing the offer/answer/ice flow. */
class FakePc {
  channel = new FakeChannel();
  localDesc: any = null;
  remoteDesc: any = null;
  added: any[] = [];
  onicecandidate: ((ev: { candidate: any }) => void) | null = null;
  createDataChannel(label: string) {
    expect(label).toBe('terminal');
    return this.channel as unknown as RTCDataChannel;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0-offer' }; }
  async setLocalDescription(d: any) { this.localDesc = d; }
  async setRemoteDescription(d: any) { this.remoteDesc = d; }
  async addIceCandidate(c: any) { this.added.push(c); }
  close() {}
  // test helper
  fireIce(candidate: any) { this.onicecandidate?.({ candidate }); }
}

function setup() {
  const pc = new FakePc();
  const signaling = {
    onPeerPresent: vi.fn(),
    onAnswer: vi.fn(),
    onRemoteIce: vi.fn(),
    sendOffer: vi.fn(),
    sendIce: vi.fn(),
    close: vi.fn(),
  };
  const peer = createPhonePeer({
    iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    signaling,
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
  });
  return { pc, signaling, peer };
}

describe('createPhonePeer (offerer)', () => {
  it('on peer-present, creates the terminal channel and sends an offer', async () => {
    const { pc, signaling } = setup();
    const onPresent = signaling.onPeerPresent.mock.calls[0]![0];
    await onPresent('d1');
    expect(pc.localDesc).toEqual({ type: 'offer', sdp: 'v=0-offer' });
    expect(signaling.sendOffer).toHaveBeenCalledWith({ sdp: 'v=0-offer' }, 'd1');
  });

  it('applies the answer it receives', async () => {
    const { pc, signaling } = setup();
    await signaling.onPeerPresent.mock.calls[0]![0]('d1');
    const onAnswer = signaling.onAnswer.mock.calls[0]![0];
    await onAnswer({ sdp: 'v=0-answer' }, 'd1');
    expect(pc.remoteDesc).toEqual({ type: 'answer', sdp: 'v=0-answer' });
  });

  it('trickles local ICE to signaling and applies remote ICE', async () => {
    const { pc, signaling } = setup();
    await signaling.onPeerPresent.mock.calls[0]![0]('d1');
    pc.fireIce({ candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 });
    expect(signaling.sendIce).toHaveBeenCalledWith(
      { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 }, 'd1',
    );
    const onIce = signaling.onRemoteIce.mock.calls[0]![0];
    await onIce({ candidate: 'rc', sdpMid: '0', sdpMLineIndex: 1 }, 'd1');
    expect(pc.added[0]).toEqual({ candidate: 'rc', sdpMid: '0', sdpMLineIndex: 1 });
  });

  it('null local ICE candidate (end-of-candidates) is not forwarded', async () => {
    const { pc, signaling } = setup();
    await signaling.onPeerPresent.mock.calls[0]![0]('d1');
    pc.fireIce(null);
    expect(signaling.sendIce).not.toHaveBeenCalled();
  });

  it('decodes inbound channel JSON to onMessage and fires onOpen', async () => {
    const { pc, peer } = setup();
    await pc; // ensure constructed
    const onMessage = vi.fn();
    const onOpen = vi.fn();
    peer.onMessage(onMessage);
    peer.onOpen(onOpen);
    pc.channel.fireOpen();
    expect(onOpen).toHaveBeenCalled();
    pc.channel.push({ type: 'pty.data', sid: 's1', chunk: 'x', seq: 1 });
    expect(onMessage).toHaveBeenCalledWith({ type: 'pty.data', sid: 's1', chunk: 'x', seq: 1 });
  });

  it('send() serializes a PhoneToDesktop message onto the open channel', async () => {
    const { pc, peer } = setup();
    pc.channel.fireOpen();
    peer.send({ type: 'session.input', sid: 's1', data: 'ls\r' });
    expect(JSON.parse(pc.channel.sent[0]!)).toEqual({ type: 'session.input', sid: 's1', data: 'ls\r' });
  });
});
