import { afterEach, describe, expect, it, vi } from 'vitest';

import { importPairingFromFragment, parsePairingFragment } from '../../src/mobile/pairing';

const ROOM_ID = 'B'.repeat(43);
const SECRET = 'A'.repeat(43);

describe('phone pairing', () => {
  afterEach(() => {
    history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('imports #pair, stores it, and removes it from history', async () => {
    const store = { get: vi.fn(), put: vi.fn().mockResolvedValue(undefined) };
    const replaceState = vi.spyOn(history, 'replaceState');
    location.hash = `#pair=${ROOM_ID}.${SECRET}`;

    await importPairingFromFragment(store);

    expect(store.put).toHaveBeenCalledWith({ roomId: ROOM_ID, secret: SECRET });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('rejects malformed fragments without storing them', async () => {
    const store = { get: vi.fn(), put: vi.fn() };
    location.hash = '#pair=not-a-capability';

    await expect(importPairingFromFragment(store)).rejects.toThrow('invalid_pairing');
    expect(store.put).not.toHaveBeenCalled();
    expect(parsePairingFragment('#other=value')).toBeNull();
  });
});
