import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_REMOTE_CHANNELS } from '../../shared/ipcChannels';
import { registerMobileRemoteIpc } from '../mobileRemoteIpc';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

describe('registerMobileRemoteIpc', () => {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  const controller = {
    getStatus: vi.fn(() => ({ kind: 'ready' as const, phoneConnected: false as const })),
    getPairingUrl: vi.fn(() => 'https://relay.example/#pair=room.secret'),
    pause: vi.fn(),
    resume: vi.fn(),
    rotate: vi.fn(async () => {}),
    subscribe: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    handlers.clear();
    ipcMain.handle.mockClear();
    vi.clearAllMocks();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never,
      getController: () => controller,
    });
  });

  it('registers every renderer invoke channel exactly once', () => {
    expect([...handlers.keys()]).toEqual([
      MOBILE_REMOTE_CHANNELS.getStatus,
      MOBILE_REMOTE_CHANNELS.getPairingUrl,
      MOBILE_REMOTE_CHANNELS.pause,
      MOBILE_REMOTE_CHANNELS.resume,
      MOBILE_REMOTE_CHANNELS.rotate,
    ]);
  });

  it('delegates payload-free queries and actions', async () => {
    expect(handlers.get(MOBILE_REMOTE_CHANNELS.getStatus)!({})).toEqual({
      kind: 'ready',
      phoneConnected: false,
    });
    expect(handlers.get(MOBILE_REMOTE_CHANNELS.getPairingUrl)!({})).toBe(
      'https://relay.example/#pair=room.secret',
    );
    handlers.get(MOBILE_REMOTE_CHANNELS.pause)!({});
    handlers.get(MOBILE_REMOTE_CHANNELS.resume)!({});
    await handlers.get(MOBILE_REMOTE_CHANNELS.rotate)!({});

    expect(controller.getStatus).toHaveBeenCalledTimes(1);
    expect(controller.getPairingUrl).toHaveBeenCalledTimes(1);
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(controller.resume).toHaveBeenCalledTimes(1);
    expect(controller.rotate).toHaveBeenCalledTimes(1);
  });

  it('rejects extra renderer payloads before they reach the controller', async () => {
    for (const channel of [
      MOBILE_REMOTE_CHANNELS.getStatus,
      MOBILE_REMOTE_CHANNELS.getPairingUrl,
      MOBILE_REMOTE_CHANNELS.pause,
      MOBILE_REMOTE_CHANNELS.resume,
      MOBILE_REMOTE_CHANNELS.rotate,
    ]) {
      await handlers.get(channel)!({}, { malformed: true });
    }

    expect(controller.getStatus).not.toHaveBeenCalled();
    expect(controller.getPairingUrl).not.toHaveBeenCalled();
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
    expect(controller.rotate).not.toHaveBeenCalled();
  });

  it('returns stable unavailable values while the controller is not ready', () => {
    handlers.clear();
    registerMobileRemoteIpc({
      ipcMain: ipcMain as never,
      getController: () => null,
    });

    expect(handlers.get(MOBILE_REMOTE_CHANNELS.getStatus)!({})).toEqual({
      kind: 'unavailable',
      reason: 'relay-not-configured',
    });
    expect(handlers.get(MOBILE_REMOTE_CHANNELS.getPairingUrl)!({})).toBeNull();
  });
});
