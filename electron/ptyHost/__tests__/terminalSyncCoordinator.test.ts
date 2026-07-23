import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Entry } from '../entryFactory';
import {
  commitResizeBarrier,
  enqueueChunkPublication,
  getCoordinatedSnapshot,
  onTerminalSyncPublication,
  type TerminalSyncPublication,
} from '../terminalSyncCoordinator';

const origin = { kind: 'visible-desktop', webContentsId: 7 } as const;
const disposers: Array<() => void> = [];

interface CoordinatorHarness {
  entry: Entry;
  publications: TerminalSyncPublication[];
  dispatch(chunk: string, seq: number): void;
  drain(): Promise<void>;
  resize(cols: number, rows: number): ReturnType<typeof commitResizeBarrier>;
  snapshot(): ReturnType<typeof getCoordinatedSnapshot>;
}

function createCoordinatorHarness(
  geometry: { cols: number; rows: number; epoch: number } = {
    cols: 120,
    rows: 30,
    epoch: 0,
  },
): CoordinatorHarness {
  let rendered = '';
  const entry = {
    pty: {
      pid: 1,
      resize: vi.fn(),
    },
    headless: {
      resize: vi.fn(),
      write: (chunk: string, callback?: () => void) => {
        rendered += chunk;
        callback?.();
      },
    },
    serialize: {
      serialize: vi.fn(() => rendered),
    },
    attached: new Map(),
    cols: geometry.cols,
    rows: geometry.rows,
    geometryEpoch: geometry.epoch,
    cwd: '/work',
    seq: 0,
    pendingHeadlessWrites: 0,
    backpressureWarned: false,
    terminalSyncQueue: Promise.resolve(),
  } as unknown as Entry;
  const registry = new Map<string, Entry>([['s1', entry]]);
  const publications: TerminalSyncPublication[] = [];
  disposers.push(onTerminalSyncPublication((publication) => publications.push(publication)));

  return {
    entry,
    publications,
    dispatch(chunk, seq) {
      entry.seq = seq;
      entry.headless.write(chunk);
      enqueueChunkPublication(entry, 's1', seq, chunk);
    },
    drain: () => entry.terminalSyncQueue,
    resize: (cols, rows) => commitResizeBarrier(registry, 's1', cols, rows, origin),
    snapshot: () => getCoordinatedSnapshot(registry, 's1'),
  };
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe('terminalSyncCoordinator', () => {
  it('publishes a same-turn old chunk, authoritative barrier, then new-epoch tail', async () => {
    const harness = createCoordinatorHarness();

    harness.dispatch('old', 1);
    const barrierPromise = harness.resize(150, 40);
    harness.dispatch('during-redraw', 2);

    const barrier = await barrierPromise;
    await harness.drain();

    expect(harness.publications).toEqual([
      { type: 'chunk', sid: 's1', seq: 1, chunk: 'old', geometryEpoch: 0 },
      {
        type: 'barrier',
        sid: 's1',
        seq: 2,
        snapshot: 'oldduring-redraw',
        geometry: { cols: 150, rows: 40, epoch: 1 },
      },
      { type: 'chunk', sid: 's1', seq: 2, chunk: 'during-redraw', geometryEpoch: 1 },
    ]);
    expect(barrier).toEqual({
      type: 'session.snapshot',
      sid: 's1',
      seq: 2,
      snapshot: 'oldduring-redraw',
      geometry: { cols: 150, rows: 40, epoch: 1 },
    });
    const publicationBarrier = harness.publications[1];
    const coveredTail = harness.publications[2];
    expect(publicationBarrier.type).toBe('barrier');
    expect(coveredTail.type).toBe('chunk');
    if (publicationBarrier.type === 'barrier' && coveredTail.type === 'chunk') {
      expect(coveredTail.seq).toBeLessThanOrEqual(publicationBarrier.seq);
    }
  });

  it('does not increment the epoch or publish a barrier for a no-op resize', async () => {
    const harness = createCoordinatorHarness();

    await expect(harness.resize(120, 30)).resolves.toBeNull();
    await harness.drain();

    expect(harness.entry.geometryEpoch).toBe(0);
    expect(harness.publications).toEqual([]);
    expect(harness.entry.pty.resize).not.toHaveBeenCalled();
    expect(harness.entry.headless.resize).not.toHaveBeenCalled();
  });

  it('serializes two queued changed resizes as epochs one and two', async () => {
    const harness = createCoordinatorHarness();

    const first = harness.resize(130, 31);
    const second = harness.resize(140, 32);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ geometry: { cols: 130, rows: 31, epoch: 1 } }),
      expect.objectContaining({ geometry: { cols: 140, rows: 32, epoch: 2 } }),
    ]);
    expect(harness.publications).toEqual([
      expect.objectContaining({
        type: 'barrier',
        geometry: { cols: 130, rows: 31, epoch: 1 },
      }),
      expect.objectContaining({
        type: 'barrier',
        geometry: { cols: 140, rows: 32, epoch: 2 },
      }),
    ]);
  });

  it('serializes a concurrent snapshot after a resize onto the complete epoch', async () => {
    const harness = createCoordinatorHarness();
    harness.dispatch('before', 1);

    const resize = harness.resize(140, 35);
    const snapshot = harness.snapshot();
    const [barrier, response] = await Promise.all([resize, snapshot]);

    expect(response?.geometry?.epoch).toBe(barrier?.geometry?.epoch);
    expect(response?.seq).toBeGreaterThanOrEqual(barrier?.seq ?? -1);
    expect(response).toEqual({
      type: 'session.snapshot',
      sid: 's1',
      seq: 1,
      snapshot: 'before',
      geometry: { cols: 140, rows: 35, epoch: 1 },
    });
  });

  it('rejects a failed resize without a barrier and reuses the queue for old-epoch chunks', async () => {
    const harness = createCoordinatorHarness();
    vi.mocked(harness.entry.pty.resize)
      .mockImplementationOnce(() => {
        throw new Error('resize failed');
      })
      .mockImplementation(() => undefined);

    const failedResize = harness.resize(150, 40);
    harness.dispatch('still-old', 1);

    await expect(failedResize).rejects.toThrow('resize failed');
    await harness.drain();

    expect(harness.entry.geometryEpoch).toBe(0);
    expect(harness.publications).toEqual([
      { type: 'chunk', sid: 's1', seq: 1, chunk: 'still-old', geometryEpoch: 0 },
    ]);

    harness.dispatch('queue-reused', 2);
    await harness.drain();
    expect(harness.publications.at(-1)).toEqual({
      type: 'chunk',
      sid: 's1',
      seq: 2,
      chunk: 'queue-reused',
      geometryEpoch: 0,
    });
  });

  it('returns null for resize and snapshot requests for an unknown session', async () => {
    const registry = new Map<string, Entry>();

    await expect(
      commitResizeBarrier(registry, 'missing', 150, 40, origin),
    ).resolves.toBeNull();
    await expect(getCoordinatedSnapshot(registry, 'missing')).resolves.toBeNull();
  });

  it('stops delivering publications after its listener is removed', async () => {
    const entry = createCoordinatorHarness().entry;
    const listener = vi.fn();
    const dispose = onTerminalSyncPublication(listener);

    enqueueChunkPublication(entry, 's1', 1, 'first');
    await entry.terminalSyncQueue;
    dispose();
    enqueueChunkPublication(entry, 's1', 2, 'second');
    await entry.terminalSyncQueue;

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
