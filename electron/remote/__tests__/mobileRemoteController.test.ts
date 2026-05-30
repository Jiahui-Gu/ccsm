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

describe('startMobileRemote', () => {
  it('returns null when not logged in (token provider yields null)', () => {
    const handle = startMobileRemote({
      tokenProvider: () => null,
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close: () => {} }),
    });
    expect(handle).toBeNull();
  });

  it('builds the DO url with the token query and wires signaling into the peer', () => {
    const createSignaling = vi.fn(() => fakeSignaling);
    const createPeer = vi.fn(() => ({ close: () => {} }));
    const handle = startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
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

  it('close() disposes the peer', () => {
    const close = vi.fn();
    const handle = startMobileRemote({
      tokenProvider: () => ({ token: 'JWT', doUrl: 'wss://w.example.dev/do/HASH' }),
      createSignaling: () => fakeSignaling,
      createPeer: () => ({ close }),
    });
    handle!.close();
    expect(close).toHaveBeenCalled();
  });
});
