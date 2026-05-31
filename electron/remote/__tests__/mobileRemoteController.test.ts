// electron/remote/__tests__/mobileRemoteController.test.ts
import { describe, it, expect, vi } from 'vitest';

// `mobileRemoteController` statically imports `createDesktopPeer` → `desktopPeer`
// → `../ptyHost` → `electron/ptyHost/index.ts`, which pulls in the real
// `electron` runtime. Under plain-Node vitest (CI) that throws at import time.
// This test injects its own `createPeer`, so it never runs the real peer — it
// only needs `ptyHost` to be importable. Stub it exactly like the sibling
// loopback test does.
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [],
  getBufferSnapshot: async () => ({ snapshot: '', seq: 0 }),
  getPtySession: () => ({ cols: 80, rows: 24 }),
  inputPtySession: () => {},
  resizePtySession: () => {},
  onPtyData: () => () => {},
}));

import { startMobileRemote } from '../mobileRemoteController';
import type { SignalingClient } from '../signaling';

const fakeSignaling: SignalingClient = {
  onOffer: () => {}, onRemoteIce: () => {}, sendAnswer: () => {}, sendIce: () => {}, close: () => {},
};

const GOOGLE_STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

describe('startMobileRemote', () => {
  it('returns null when not logged in (token provider yields null)', async () => {
    const handle = await startMobileRemote({
      tokenProvider: () => null,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(handle).toBeNull();
  });

  it('does not fetch ICE when logged out', async () => {
    const fetchIce = vi.fn(async () => [{ urls: 'turn:x' }]);
    const handle = await startMobileRemote({
      tokenProvider: () => null,
      fetchIce,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(handle).toBeNull();
    expect(fetchIce).not.toHaveBeenCalled();
  });

  it('builds the DO url with the token query and wires signaling into the peer', async () => {
    const createSignaling = vi.fn(() => fakeSignaling);
    const createPeer = vi.fn(() => ({ close: () => {} }));
    const handle = await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      fetchIce: async () => null,
      createSignaling,
      createPeer,
    });
    expect(handle).not.toBeNull();
    expect(createSignaling).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'wss://w.example.dev/do/HASH?token=JWT' }),
    );
    expect(createPeer).toHaveBeenCalledWith(
      expect.objectContaining({ signaling: fakeSignaling }),
    );
  });

  it('close() disposes the peer', async () => {
    const close = vi.fn();
    const handle = await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      fetchIce: async () => null,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close }),
    });
    handle!.close();
    expect(close).toHaveBeenCalled();
  });

  it('uses Worker-fetched ICE servers when fetchIce resolves a non-empty array', async () => {
    const fetched = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' },
    ];
    const createPeer = vi.fn(() => ({ close: () => {} }));
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      fetchIce: async () => fetched,
      createSignaling: () => fakeSignaling,
      createPeer,
    });
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: fetched }));
  });

  it('passes the session token + workerOrigin to fetchIce', async () => {
    const fetchIce = vi.fn(async () => null);
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      fetchIce,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(fetchIce).toHaveBeenCalledWith(
      expect.objectContaining({ workerOrigin: 'https://w.example.dev', token: 'JWT' }),
    );
  });

  it('falls back to Google STUN when fetchIce resolves null', async () => {
    const createPeer = vi.fn(() => ({ close: () => {} }));
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      fetchIce: async () => null,
      createSignaling: () => fakeSignaling,
      createPeer,
    });
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: GOOGLE_STUN }));
  });

  it('injected opts.iceServers wins over fetchIce', async () => {
    const fetchIce = vi.fn(async () => [{ urls: 'turn:should-not-be-used' }]);
    const injected = [{ urls: 'stun:injected:3478' }];
    const createPeer = vi.fn(() => ({ close: () => {} }));
    await startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      workerOrigin: 'https://w.example.dev',
      iceServers: injected,
      fetchIce,
      createSignaling: () => fakeSignaling,
      createPeer,
    });
    expect(fetchIce).not.toHaveBeenCalled();
    expect(createPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: injected }));
  });
});
