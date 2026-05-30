// electron/remote/__tests__/doSignalingClient.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDoSignalingClient } from '../doSignalingClient';

/** Minimal WebSocket fake mirroring src/mobile phoneSignaling.test.ts. */
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
  fireOpen() { this.onopen?.(); }
  push(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  lastJson() { return JSON.parse(this.sent[this.sent.length - 1]!); }
}

function setup() {
  const ws = new FakeWs();
  const sig = createDoSignalingClient({
    url: 'wss://ccsm-worker.example.workers.dev/do/HASH?token=JWT',
    peerId: 'd1',
    createWebSocket: () => ws as unknown as WebSocket,
  });
  return { ws, sig };
}

describe('createDoSignalingClient', () => {
  it('registers as desktop on open', () => {
    const { ws } = setup();
    ws.fireOpen();
    expect(ws.lastJson()).toEqual({ type: 'register', role: 'desktop', peerId: 'd1' });
  });

  it('routes an inbound offer to onOffer with the sender peerId', () => {
    const { ws, sig } = setup();
    const onOffer = vi.fn();
    sig.onOffer(onOffer);
    ws.fireOpen();
    ws.push({ type: 'offer', to: 'd1', from: 'p1', sdp: 'v=0-offer' });
    expect(onOffer).toHaveBeenCalledWith({ type: 'offer', sdp: 'v=0-offer' }, 'p1');
  });

  it('routes inbound ice to onRemoteIce with the sender peerId', () => {
    const { ws, sig } = setup();
    const onIce = vi.fn();
    sig.onRemoteIce(onIce);
    ws.fireOpen();
    ws.push({ type: 'ice', to: 'd1', from: 'p1', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 });
    expect(onIce).toHaveBeenCalledWith({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 }, 'p1');
  });

  it('sendAnswer frames an answer to the phone peerId with from=self', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    sig.sendAnswer({ type: 'answer', sdp: 'v=0-answer' }, 'p1');
    expect(ws.lastJson()).toEqual({ type: 'answer', to: 'p1', from: 'd1', sdp: 'v=0-answer' });
  });

  it('sendIce frames ice to the phone peerId with from=self', () => {
    const { ws, sig } = setup();
    ws.fireOpen();
    sig.sendIce({ candidate: 'c', sdpMid: '0', sdpMLineIndex: 1 }, 'p1');
    expect(ws.lastJson()).toEqual({
      type: 'ice', to: 'p1', from: 'd1', candidate: 'c', sdpMid: '0', sdpMLineIndex: 1,
    });
  });

  it('close() closes the socket', () => {
    const { ws, sig } = setup();
    const onClose = vi.fn();
    ws.onclose = onClose;
    ws.fireOpen();
    sig.close();
    expect(onClose).toHaveBeenCalled();
  });
});
