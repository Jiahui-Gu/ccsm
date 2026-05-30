// @vitest-environment node
// werift drives real UDP (ICE) + SCTP over Node's net/dgram stack. The default
// jsdom environment shims those globals and the DataChannel never opens, so
// this loopback suite must run in the plain Node environment.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RTCPeerConnection } from 'werift';

const inputCalls: Array<[string, string]> = [];
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24, pid: 1 }],
  getBufferSnapshot: async () => ({ data: '', seq: 0 }),
  getPtySession: () => ({ cols: 80, rows: 24 }),
  inputPtySession: (sid: string, data: string) => { inputCalls.push([sid, data]); },
  resizePtySession: () => {},
  onPtyData: (cb: (sid: string, chunk: string, seq: number) => void) => {
    emitPtyData = cb;
    return () => { emitPtyData = null; };
  },
}));

let emitPtyData: ((sid: string, chunk: string, seq: number) => void) | null = null;

import { createDesktopPeer } from '../desktopPeer';
import type { SignalingClient, SignalDescription, SignalCandidate } from '../signaling';

/** In-memory signaling bus: directly hands the desktop side whatever the phone
 *  side produces and vice-versa. No network. */
function makeSignalingPair() {
  let onOfferCb: ((o: SignalDescription, p: string) => void) | null = null;
  let onIceCb: ((c: SignalCandidate, p: string) => void) | null = null;
  const phone = {
    deliverAnswer: null as null | ((a: SignalDescription) => void),
    deliverIce: null as null | ((c: SignalCandidate) => void),
    sendOffer(o: SignalDescription) { onOfferCb?.(o, 'phone1'); },
    sendIce(c: SignalCandidate) { onIceCb?.(c, 'phone1'); },
  };
  const desktopSignaling: SignalingClient = {
    onOffer: (cb) => { onOfferCb = cb; },
    onRemoteIce: (cb) => { onIceCb = cb; },
    sendAnswer: (a) => phone.deliverAnswer?.(a),
    sendIce: (c) => phone.deliverIce?.(c),
    close: () => {},
  };
  return { phone, desktopSignaling };
}

describe('createDesktopPeer loopback', () => {
  beforeEach(() => { inputCalls.length = 0; });

  it('runs session.input over a real DataChannel into ptyHost', async () => {
    const { phone, desktopSignaling } = makeSignalingPair();
    const clients = new Set<{ subscribedSid: string | null; send: (p: unknown) => void }>();
    const peer = createDesktopPeer({ iceServers: [], signaling: desktopSignaling, clients });

    const phonePc = new RTCPeerConnection({ iceServers: [] });
    const dc = phonePc.createDataChannel('terminal');
    phonePc.onIceCandidate.subscribe((c) => { if (c) phone.sendIce(c as SignalCandidate); });
    phone.deliverAnswer = async (a) => { await phonePc.setRemoteDescription(a as never); };
    phone.deliverIce = async (c) => { await phonePc.addIceCandidate(c as never); };

    const offer = await phonePc.createOffer();
    await phonePc.setLocalDescription(offer);
    phone.sendOffer({ type: 'offer', sdp: offer.sdp });

    await new Promise<void>((resolve) => { dc.onopen = () => resolve(); });
    dc.send(JSON.stringify({ type: 'session.input', sid: 's1', data: 'ls\n' }));

    await vi.waitFor(() => expect(inputCalls).toEqual([['s1', 'ls\n']]), { timeout: 5000 });

    peer.close();
    await phonePc.close();
  }, 15000);

  it('forwards pty.data only after subscribe and only for the viewed session', async () => {
    const { phone, desktopSignaling } = makeSignalingPair();
    const clients = new Set<{ subscribedSid: string | null; send: (p: unknown) => void }>();
    const peer = createDesktopPeer({ iceServers: [], signaling: desktopSignaling, clients });

    const phonePc = new RTCPeerConnection({ iceServers: [] });
    const dc = phonePc.createDataChannel('terminal');
    phonePc.onIceCandidate.subscribe((c) => { if (c) phone.sendIce(c as SignalCandidate); });
    phone.deliverAnswer = async (a) => { await phonePc.setRemoteDescription(a as never); };
    phone.deliverIce = async (c) => { await phonePc.addIceCandidate(c as never); };

    const received: Array<Record<string, unknown>> = [];
    dc.onmessage = (e) => received.push(JSON.parse(e.data as string));

    const offer = await phonePc.createOffer();
    await phonePc.setLocalDescription(offer);
    phone.sendOffer({ type: 'offer', sdp: offer.sdp });
    await new Promise<void>((resolve) => { dc.onopen = () => resolve(); });

    // Before subscribe: a pty.data for s1 must NOT reach this client.
    emitPtyData?.('s1', 'early', 1);
    // Subscribe to s1, then emit again.
    dc.send(JSON.stringify({ type: 'session.snapshot', sid: 's1' }));
    await vi.waitFor(() => expect(received.some((m) => m.type === 'session.snapshot')).toBe(true), { timeout: 5000 });
    emitPtyData?.('s2', 'wrong-session', 2);
    emitPtyData?.('s1', 'right-session', 3);

    await vi.waitFor(() => {
      const data = received.filter((m) => m.type === 'pty.data');
      expect(data).toEqual([{ type: 'pty.data', sid: 's1', chunk: 'right-session', seq: 3 }]);
    }, { timeout: 5000 });

    peer.close();
    await phonePc.close();
  }, 15000);
});
