import { beforeEach, describe, expect, it, vi } from 'vitest';

const fanoutBus = vi.hoisted(() => ({
  orderedListeners: [] as Array<(publication: Record<string, unknown>) => void>,
  rawListeners: [] as Array<(sid: string, chunk: string, seq: number) => void>,
  onOrdered: vi.fn(),
  onRaw: vi.fn(),
}));

vi.mock('../../ptyHost', () => ({
  getPtySession: vi.fn(() => ({
    geometry: { cols: 80, rows: 24, epoch: 0 },
  })),
  onPtyData: fanoutBus.onRaw.mockImplementation(
    (listener: (sid: string, chunk: string, seq: number) => void) => {
      fanoutBus.rawListeners.push(listener);
      return () => fanoutBus.rawListeners.splice(fanoutBus.rawListeners.indexOf(listener), 1);
    },
  ),
  onTerminalSyncPublication: fanoutBus.onOrdered.mockImplementation(
    (listener: (publication: Record<string, unknown>) => void) => {
      fanoutBus.orderedListeners.push(listener);
      return () =>
        fanoutBus.orderedListeners.splice(fanoutBus.orderedListeners.indexOf(listener), 1);
    },
  ),
}));

import { installPtyFanout } from '../ptyFanout';
import type { RemotePeer } from '../remotePeer';

beforeEach(() => {
  fanoutBus.orderedListeners.splice(0);
  fanoutBus.rawListeners.splice(0);
  fanoutBus.onOrdered.mockClear();
  fanoutBus.onRaw.mockClear();
});

describe('installPtyFanout', () => {
  it('subscribes only to ordered terminal publications, not the raw sink', () => {
    const uninstall = installPtyFanout(new Set());

    expect(fanoutBus.onOrdered).toHaveBeenCalledTimes(1);
    expect(fanoutBus.onRaw).not.toHaveBeenCalled();

    uninstall();
    expect(fanoutBus.orderedListeners).toHaveLength(0);
  });

  it('forwards chunk publications only to peers subscribed to that session', () => {
    const matching: RemotePeer = { subscribedSid: 's1', send: vi.fn() };
    const other: RemotePeer = { subscribedSid: 's2', send: vi.fn() };
    const uninstall = installPtyFanout(new Set([matching, other]));

    fanoutBus.orderedListeners[0]?.({
      type: 'chunk',
      sid: 's1',
      seq: 4,
      chunk: 'tail',
      geometryEpoch: 2,
    });

    expect(matching.send).toHaveBeenCalledWith({
      type: 'pty.data',
      sid: 's1',
      seq: 4,
      chunk: 'tail',
      geometryEpoch: 2,
    });
    expect(other.send).not.toHaveBeenCalled();
    uninstall();
  });

  it('forwards resize barriers as authoritative session snapshots', () => {
    const peer: RemotePeer = { subscribedSid: 's1', send: vi.fn() };
    const uninstall = installPtyFanout(new Set([peer]));

    fanoutBus.orderedListeners[0]?.({
      type: 'barrier',
      sid: 's1',
      seq: 8,
      snapshot: 'screen',
      geometry: { cols: 150, rows: 40, epoch: 3 },
    });

    expect(peer.send).toHaveBeenCalledWith({
      type: 'session.snapshot',
      sid: 's1',
      seq: 8,
      snapshot: 'screen',
      geometry: { cols: 150, rows: 40, epoch: 3 },
    });
    uninstall();
  });
});
