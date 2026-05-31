// electron/remote/__tests__/mobileRemote.e2e.loopback.test.ts
// @vitest-environment node
// werift drives real UDP (ICE) + SCTP; jsdom shims break the DataChannel.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RTCPeerConnection } from 'werift';

const inputCalls: Array<[string, string]> = [];
let emitPtyData: ((sid: string, chunk: string, seq: number) => void) | null = null;
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24, pid: 1 }],
  getBufferSnapshot: async () => ({ snapshot: 'SNAP', seq: 5 }),
  getPtySession: () => ({ cols: 80, rows: 24 }),
  inputPtySession: (sid: string, data: string) => { inputCalls.push([sid, data]); },
  resizePtySession: () => {},
  onPtyData: (cb: (sid: string, chunk: string, seq: number) => void) => {
    emitPtyData = cb;
    return () => { emitPtyData = null; };
  },
}));

import { createDesktopPeer } from '../desktopPeer';
import { createDoSignalingClient } from '../doSignalingClient';
import { createPhoneSignaling } from '../../../src/mobile/phoneSignaling';
import { createPhonePeer } from '../../../src/mobile/phonePeer';
import { wirePhoneApp, type PhoneUi } from '../../../src/mobile/phoneApp';

/** Two in-process WebSocket fakes joined back-to-back: whatever one `send`s is
 *  delivered to the other's onmessage. This is the DO, collapsed to a wire. The
 *  desktop registers as 'desktop', the phone as 'phone'; the bridge answers
 *  register with a `registered`/`peer-present` so each side learns the other,
 *  and routes offer/answer/ice by the `to` field. */
function makeDoBridge() {
  type Sock = {
    role: 'desktop' | 'phone';
    peerId: string;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    onclose: (() => void) | null;
    send: (s: string) => void;
    close: () => void;
  };
  const socks: Record<string, Sock> = {};
  const byRole: Record<string, Sock | undefined> = {};

  function deliver(to: string, payload: unknown) {
    socks[to]?.onmessage?.({ data: JSON.stringify(payload) });
  }

  function makeSock(): Sock {
    const sock: Sock = {
      role: 'phone', peerId: '', onopen: null, onmessage: null, onclose: null,
      send: (s: string) => {
        const msg = JSON.parse(s) as Record<string, unknown>;
        if (msg.type === 'register') {
          sock.role = msg.role as 'desktop' | 'phone';
          sock.peerId = msg.peerId as string;
          socks[sock.peerId] = sock;
          byRole[sock.role] = sock;
          const other = sock.role === 'phone' ? byRole.desktop : byRole.phone;
          const otherRole = sock.role === 'phone' ? 'desktop' : 'phone';
          deliver(sock.peerId, {
            type: 'registered', peerId: sock.peerId,
            peers: other ? [{ role: otherRole, peerId: other.peerId }] : [],
          });
          if (other) {
            deliver(other.peerId, { type: 'peer-present', role: sock.role, peerId: sock.peerId });
          }
          return;
        }
        // offer/answer/ice all carry { to }
        deliver(msg.to as string, msg);
      },
      close: () => sock.onclose?.(),
    };
    // fire open on next tick so the caller can assign handlers first
    queueMicrotask(() => sock.onopen?.());
    return sock;
  }

  return {
    desktopWsFactory: () => makeSock() as unknown as WebSocket,
    phoneWsFactory: () => makeSock() as unknown as WebSocket,
  };
}

function makeUi() {
  const writes: string[] = [];
  const ui: PhoneUi = {
    renderSessions: () => {},
    selectSession: () => {},
    write: (c) => { writes.push(c); },
    reset: () => {},
    setStatus: () => {},
  };
  return { ui, writes };
}

describe('mobile-remote loopback e2e (real phone modules ↔ desktop peer)', () => {
  beforeEach(() => { inputCalls.length = 0; emitPtyData = null; });

  it('runs the full protocol over a real DataChannel between the real modules', async () => {
    const bridge = makeDoBridge();

    // Desktop answerer with the real DO signaling client (in-process WS).
    const desktopSignaling = createDoSignalingClient({
      url: 'wss://bridge/do/HASH?token=JWT', peerId: 'd1',
      createWebSocket: bridge.desktopWsFactory,
    });
    const clients = new Set<{ subscribedSid: string | null; send: (p: unknown) => void }>();
    const desktop = createDesktopPeer({ iceServers: [], signaling: desktopSignaling, clients });

    // Phone offerer with the real phone modules + werift injected.
    const phoneSignaling = createPhoneSignaling({
      url: 'wss://bridge/do/HASH?token=JWT', peerId: 'p1',
      createWebSocket: bridge.phoneWsFactory,
    });
    const phonePeer = createPhonePeer({
      iceServers: [],
      signaling: phoneSignaling,
      createPeerConnection: (c) => new RTCPeerConnection(c) as unknown as RTCPeerConnection,
    });
    const { ui, writes } = makeUi();
    const app = wirePhoneApp(phonePeer, ui);

    // Wait for the channel to open (phoneApp sets status connected on open).
    await vi.waitFor(() => expect(writes.length >= 0).toBe(true), { timeout: 8000 });
    await new Promise<void>((resolve) => {
      phonePeer.onOpen(() => resolve());
    });

    // Phone selects s1 → desktop replies snapshot (SNAP, seq 5).
    app.select('s1');
    await vi.waitFor(() => expect(writes.join('')).toContain('SNAP'), { timeout: 8000 });

    // pty.data seq <= 5 is deduped; seq 6 paints.
    emitPtyData?.('s1', 'OLD', 4);
    emitPtyData?.('s1', 'NEW', 6);
    await vi.waitFor(() => expect(writes.join('')).toContain('NEW'), { timeout: 8000 });
    expect(writes.join('')).not.toContain('OLD');

    // Phone input reaches ptyHost.
    app.sendInput('ls\n');
    await vi.waitFor(() => expect(inputCalls).toContainEqual(['s1', 'ls\n']), { timeout: 8000 });

    app.close();
    desktop.close();
  }, 30000);
});
