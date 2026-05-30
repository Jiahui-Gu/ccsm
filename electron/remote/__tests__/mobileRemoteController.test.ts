// electron/remote/__tests__/mobileRemoteController.test.ts
import { describe, it, expect, vi } from 'vitest';
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
