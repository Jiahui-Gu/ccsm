import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_REMOTE_CHANNELS } from '../../../shared/ipcChannels';

const { exposeSpy, invokeSpy, onSpy, removeListenerSpy } = vi.hoisted(() => ({
  exposeSpy: vi.fn(),
  invokeSpy: vi.fn(),
  onSpy: vi.fn(),
  removeListenerSpy: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposeSpy },
  ipcRenderer: {
    invoke: invokeSpy,
    on: onSpy,
    removeListener: removeListenerSpy,
  },
}));

import { installCcsmMobileRemoteBridge } from '../ccsmMobileRemote';

function api(): Record<string, (...args: never[]) => unknown> {
  const [name, value] = exposeSpy.mock.calls.at(-1)!;
  expect(name).toBe('ccsmMobileRemote');
  return value;
}

describe('ccsmMobileRemote preload bridge', () => {
  beforeEach(() => {
    exposeSpy.mockReset();
    invokeSpy.mockReset();
    onSpy.mockReset();
    removeListenerSpy.mockReset();
    installCcsmMobileRemoteBridge();
  });

  it('exposes the complete mobile remote API', () => {
    expect(Object.keys(api()).sort()).toEqual(
      ['getStatus', 'getPairingUrl', 'pause', 'resume', 'rotate', 'onStatus'].sort(),
    );
  });

  it('invokes action channels without renderer payloads', () => {
    const bridge = api();
    bridge.getStatus();
    bridge.getPairingUrl();
    bridge.pause();
    bridge.resume();
    bridge.rotate();

    expect(invokeSpy.mock.calls).toEqual([
      [MOBILE_REMOTE_CHANNELS.getStatus],
      [MOBILE_REMOTE_CHANNELS.getPairingUrl],
      [MOBILE_REMOTE_CHANNELS.pause],
      [MOBILE_REMOTE_CHANNELS.resume],
      [MOBILE_REMOTE_CHANNELS.rotate],
    ]);
  });

  it('removes the exact status listener when unsubscribed', () => {
    const handler = vi.fn();
    const off = api().onStatus(handler as never) as () => void;
    const listener = onSpy.mock.calls[0][1];
    const status = { kind: 'ready', phoneConnected: true };

    expect(onSpy).toHaveBeenCalledWith(MOBILE_REMOTE_CHANNELS.status, listener);
    listener({}, status);
    expect(handler).toHaveBeenCalledWith(status);

    off();
    expect(removeListenerSpy).toHaveBeenCalledWith(MOBILE_REMOTE_CHANNELS.status, listener);
  });
});
