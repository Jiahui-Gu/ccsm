import { describe, expect, it } from 'vitest';

import {
  applyTerminalChunk,
  applyTerminalSnapshot,
  beginTerminalSync,
  emptyTerminalSync,
  MAX_BUFFERED_TERMINAL_CHUNKS,
  type TerminalSyncState,
} from '../../src/mobile/terminalSync';
import type {
  PtyDataMessage,
  SessionSnapshotMessage,
  TerminalGeometry,
} from '../../src/shared/mobileRemote';

function chunk(
  seq: number,
  geometryEpoch: number,
  data: string,
  sid = 's1',
): PtyDataMessage {
  return { type: 'pty.data', sid, seq, chunk: data, geometryEpoch };
}

function snapshot(
  seq: number,
  geometry: TerminalGeometry,
  data: string,
  sid = 's1',
): SessionSnapshotMessage {
  return { type: 'session.snapshot', sid, seq, snapshot: data, geometry };
}

function syncedState(
  geometry: TerminalGeometry,
  lastSeq: number,
  sid = 's1',
): TerminalSyncState {
  return {
    sid,
    phase: 'live',
    geometry,
    lastSeq,
    buffered: new Map(),
    snapshotRequested: false,
    recoveryReason: null,
  };
}

describe('terminalSync geometry epochs', () => {
  it('starts idle and begins a session with exactly one outstanding initial recovery', () => {
    expect(emptyTerminalSync()).toEqual({
      sid: null,
      phase: 'idle',
      geometry: null,
      lastSeq: -1,
      buffered: new Map(),
      snapshotRequested: false,
      recoveryReason: null,
    });
    expect(beginTerminalSync('s1')).toEqual({
      sid: 's1',
      phase: 'syncing',
      geometry: null,
      lastSeq: -1,
      buffered: new Map(),
      snapshotRequested: true,
      recoveryReason: 'initial',
    });
  });

  it.each([
    ['wrong sid', chunk(11, 2, 'wrong-session', 's2')],
    ['stale epoch', chunk(11, 1, 'stale')],
    ['duplicate seq', chunk(10, 2, 'duplicate')],
    ['old seq', chunk(9, 2, 'old')],
  ])('ignores %s without effects or recovery', (_label, message) => {
    const state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
    const result = applyTerminalChunk(state, message);

    expect(result).toEqual({ state, effects: [] });
    expect(result.state.snapshotRequested).toBe(false);
    expect(result.state.recoveryReason).toBeNull();
  });

  it('writes a same-epoch contiguous chunk with its session and sequence', () => {
    const result = applyTerminalChunk(
      syncedState({ cols: 120, rows: 30, epoch: 2 }, 10),
      chunk(11, 2, 'next'),
    );

    expect(result.effects).toEqual([
      { type: 'write', sid: 's1', seq: 11, data: 'next' },
    ]);
    expect(result.state).toMatchObject({
      phase: 'live',
      lastSeq: 11,
      snapshotRequested: false,
      recoveryReason: null,
    });
  });

  it('buffers a same-epoch gap immutably and requests one sequence-gap recovery', () => {
    const state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
    const originalBuffer = state.buffered;
    const result = applyTerminalChunk(state, chunk(12, 2, 'gap'));

    expect(result.effects).toEqual([
      { type: 'requestSnapshot', sid: 's1', reason: 'sequence-gap' },
    ]);
    expect(result.state).toMatchObject({
      phase: 'syncing',
      snapshotRequested: true,
      recoveryReason: 'sequence-gap',
      lastSeq: 10,
      geometry: { cols: 120, rows: 30, epoch: 2 },
    });
    expect(result.state.buffered).not.toBe(originalBuffer);
    expect(result.state.buffered.get(12)).toEqual(chunk(12, 2, 'gap'));
    expect(originalBuffer.size).toBe(0);
  });

  it('buffers a future epoch and requests exactly one snapshot while syncing', () => {
    const live = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
    const first = applyTerminalChunk(live, chunk(12, 3, 'tail-12'));
    const second = applyTerminalChunk(first.state, chunk(11, 3, 'tail-11'));

    expect(first.effects).toEqual([
      { type: 'requestSnapshot', sid: 's1', reason: 'future-geometry' },
    ]);
    expect(second.effects).toEqual([]);
    expect(second.state).toMatchObject({
      phase: 'syncing',
      geometry: live.geometry,
      lastSeq: 10,
      snapshotRequested: true,
      recoveryReason: 'future-geometry',
    });
    expect([...second.state.buffered.keys()]).toEqual([12, 11]);
  });

  it('buffers pre-snapshot data without geometry and does not duplicate the initial request', () => {
    const initial = beginTerminalSync('s1');
    const result = applyTerminalChunk(initial, chunk(1, 4, 'early'));

    expect(result.effects).toEqual([]);
    expect(result.state.buffered.get(1)).toEqual(chunk(1, 4, 'early'));
    expect(result.state.recoveryReason).toBe('initial');
  });

  it('keeps the first buffered publication for a duplicate sequence', () => {
    const first = applyTerminalChunk(beginTerminalSync('s1'), chunk(5, 3, 'first'));
    const duplicate = applyTerminalChunk(first.state, chunk(5, 3, 'second'));

    expect(duplicate).toEqual({ state: first.state, effects: [] });
    expect(duplicate.state.buffered.get(5)?.chunk).toBe('first');
  });

  it('installs a future-epoch barrier once and drains only its contiguous tail', () => {
    let state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
    state = applyTerminalChunk(state, chunk(12, 3, 'tail-12')).state;
    state = applyTerminalChunk(state, chunk(11, 3, 'tail-11')).state;

    const result = applyTerminalSnapshot(
      state,
      snapshot(10, { cols: 150, rows: 40, epoch: 3 }, 'screen-v3'),
    );

    expect(result.effects).toEqual([
      {
        type: 'installSnapshot',
        sid: 's1',
        seq: 10,
        snapshot: 'screen-v3',
        geometry: { cols: 150, rows: 40, epoch: 3 },
      },
      { type: 'write', sid: 's1', seq: 11, data: 'tail-11' },
      { type: 'write', sid: 's1', seq: 12, data: 'tail-12' },
    ]);
    expect(result.state).toMatchObject({
      phase: 'live',
      geometry: { cols: 150, rows: 40, epoch: 3 },
      lastSeq: 12,
      snapshotRequested: false,
      recoveryReason: null,
    });
    expect(result.state.buffered.size).toBe(0);
  });

  it.each([
    [
      'wrong sid',
      snapshot(11, { cols: 120, rows: 30, epoch: 2 }, 'wrong-session', 's2'),
    ],
    [
      'stale epoch',
      snapshot(20, { cols: 80, rows: 24, epoch: 1 }, 'stale-geometry'),
    ],
    [
      'superseded same-epoch barrier',
      snapshot(10, { cols: 120, rows: 30, epoch: 2 }, 'superseded'),
    ],
  ])('ignores a %s without effects or recovery', (_label, message) => {
    const state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
    const result = applyTerminalSnapshot(state, message);

    expect(result).toEqual({ state, effects: [] });
    expect(result.state.snapshotRequested).toBe(false);
    expect(result.state.recoveryReason).toBeNull();
  });

  it('accepts a future barrier even when its sequence is behind the old epoch', () => {
    const result = applyTerminalSnapshot(
      syncedState({ cols: 120, rows: 30, epoch: 2 }, 10),
      snapshot(8, { cols: 150, rows: 40, epoch: 3 }, 'new-epoch'),
    );

    expect(result.effects).toEqual([
      {
        type: 'installSnapshot',
        sid: 's1',
        seq: 8,
        snapshot: 'new-epoch',
        geometry: { cols: 150, rows: 40, epoch: 3 },
      },
    ]);
    expect(result.state).toMatchObject({
      phase: 'live',
      lastSeq: 8,
      geometry: { cols: 150, rows: 40, epoch: 3 },
    });
  });

  it('treats snapshot/live overlap as covered and never replays covered tails', () => {
    let state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
    state = applyTerminalChunk(state, chunk(11, 3, 'covered-11')).state;
    state = applyTerminalChunk(state, chunk(12, 3, 'covered-12')).state;

    const result = applyTerminalSnapshot(
      state,
      snapshot(12, { cols: 150, rows: 40, epoch: 3 }, 'covers-tail'),
    );

    expect(result.effects).toEqual([
      {
        type: 'installSnapshot',
        sid: 's1',
        seq: 12,
        snapshot: 'covers-tail',
        geometry: { cols: 150, rows: 40, epoch: 3 },
      },
    ]);
    expect(result.state.buffered.size).toBe(0);
    expect(result.state).toMatchObject({ phase: 'live', lastSeq: 12 });
  });

  it('discards buffered publications from other epochs when installing a barrier', () => {
    const state: TerminalSyncState = {
      ...syncedState({ cols: 120, rows: 30, epoch: 2 }, 10),
      phase: 'syncing',
      snapshotRequested: true,
      recoveryReason: 'future-geometry',
      buffered: new Map([
        [11, chunk(11, 3, 'matching')],
        [12, chunk(12, 4, 'other-epoch')],
      ]),
    };

    const result = applyTerminalSnapshot(
      state,
      snapshot(10, { cols: 150, rows: 40, epoch: 3 }, 'screen-v3'),
    );

    expect(result.effects).toEqual([
      {
        type: 'installSnapshot',
        sid: 's1',
        seq: 10,
        snapshot: 'screen-v3',
        geometry: { cols: 150, rows: 40, epoch: 3 },
      },
      { type: 'write', sid: 's1', seq: 11, data: 'matching' },
    ]);
    expect(result.state).toMatchObject({ phase: 'live', lastSeq: 11 });
    expect(result.state.buffered.size).toBe(0);
  });

  it('keeps the installed frame and geometry visible when a gap remains', () => {
    const oldGeometry = { cols: 120, rows: 30, epoch: 2 };
    const newGeometry = { cols: 150, rows: 40, epoch: 3 };
    const state: TerminalSyncState = {
      ...syncedState(oldGeometry, 10),
      phase: 'syncing',
      snapshotRequested: true,
      recoveryReason: 'future-geometry',
      buffered: new Map([
        [12, chunk(12, 3, 'tail-12')],
        [14, chunk(14, 3, 'tail-14')],
        [11, chunk(11, 3, 'tail-11')],
      ]),
    };

    const result = applyTerminalSnapshot(state, snapshot(10, newGeometry, 'screen-v3'));

    expect(result.effects).toEqual([
      {
        type: 'installSnapshot',
        sid: 's1',
        seq: 10,
        snapshot: 'screen-v3',
        geometry: newGeometry,
      },
      { type: 'write', sid: 's1', seq: 11, data: 'tail-11' },
      { type: 'write', sid: 's1', seq: 12, data: 'tail-12' },
      { type: 'requestSnapshot', sid: 's1', reason: 'sequence-gap' },
    ]);
    expect(result.state).toMatchObject({
      phase: 'syncing',
      geometry: newGeometry,
      lastSeq: 12,
      snapshotRequested: true,
      recoveryReason: 'sequence-gap',
    });
    expect([...result.state.buffered.keys()]).toEqual([14]);

    const stillSyncing = applyTerminalChunk(result.state, chunk(15, 3, 'tail-15'));
    expect(stillSyncing.effects).toEqual([]);
    expect(stillSyncing.state.geometry).toEqual(newGeometry);
    expect(stillSyncing.state.lastSeq).toBe(12);
  });

  it('allows exactly 256 buffered chunks without overflow', () => {
    let state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 0);
    let recoveryRequests = 0;
    for (let seq = 1; seq <= MAX_BUFFERED_TERMINAL_CHUNKS; seq += 1) {
      const result = applyTerminalChunk(state, chunk(seq + 1, 3, `future-${seq}`));
      recoveryRequests += result.effects.filter(
        (effect) => effect.type === 'requestSnapshot',
      ).length;
      state = result.state;
    }

    expect(state.buffered.size).toBe(MAX_BUFFERED_TERMINAL_CHUNKS);
    expect(state.recoveryReason).toBe('future-geometry');
    expect(recoveryRequests).toBe(1);
  });

  it('clears the unsafe buffer on the 257th chunk and keeps recovery bounded', () => {
    let state = syncedState({ cols: 120, rows: 30, epoch: 2 }, 0);
    let recoveryRequests = 0;
    for (let seq = 1; seq <= MAX_BUFFERED_TERMINAL_CHUNKS + 1; seq += 1) {
      const result = applyTerminalChunk(state, chunk(seq + 1, 3, `future-${seq}`));
      recoveryRequests += result.effects.filter(
        (effect) => effect.type === 'requestSnapshot',
      ).length;
      state = result.state;
    }

    expect(state.buffered.size).toBe(0);
    expect(state).toMatchObject({
      phase: 'syncing',
      geometry: { cols: 120, rows: 30, epoch: 2 },
      lastSeq: 0,
      snapshotRequested: true,
      recoveryReason: 'buffer-overflow',
    });
    expect(recoveryRequests).toBe(1);
  });

  it('does not treat a duplicate as overflow when the buffer is full', () => {
    const buffered = new Map<number, PtyDataMessage>();
    for (let seq = 1; seq <= MAX_BUFFERED_TERMINAL_CHUNKS; seq += 1) {
      buffered.set(seq, chunk(seq, 3, `future-${seq}`));
    }
    const state: TerminalSyncState = {
      ...syncedState({ cols: 120, rows: 30, epoch: 2 }, 0),
      phase: 'syncing',
      buffered,
      snapshotRequested: true,
      recoveryReason: 'future-geometry',
    };

    expect(applyTerminalChunk(state, chunk(256, 3, 'duplicate'))).toEqual({
      state,
      effects: [],
    });
  });

  it('reconnect and session reset discard old data and reject late old-session effects', () => {
    let oldState = syncedState({ cols: 120, rows: 30, epoch: 2 }, 10);
    oldState = applyTerminalChunk(oldState, chunk(12, 3, 'old-buffer')).state;

    const reconnected = beginTerminalSync('s1');
    expect(reconnected.buffered.size).toBe(0);
    expect(reconnected.geometry).toBeNull();
    expect(reconnected.lastSeq).toBe(-1);

    const switched = beginTerminalSync('s2');
    expect(switched.buffered.size).toBe(0);
    expect(applyTerminalChunk(switched, chunk(13, 3, 'late-s1'))).toEqual({
      state: switched,
      effects: [],
    });
    expect(
      applyTerminalSnapshot(
        switched,
        snapshot(13, { cols: 150, rows: 40, epoch: 3 }, 'late-s1'),
      ),
    ).toEqual({ state: switched, effects: [] });
  });
});
