import { describe, expect, it } from 'vitest';

import {
  applyTerminalChunk,
  applyTerminalSnapshot,
  beginTerminalSync,
  MAX_BUFFERED_TERMINAL_CHUNKS,
  type TerminalSyncState,
} from '../../src/mobile/terminalSync';

function chunk(seq: number, data: string, sid = 's1') {
  return { sid, seq, chunk: data };
}

function snapshot(seq: number, data: string, sid = 's1') {
  return { sid, seq, data };
}

function syncedState(sid: string, lastSeq: number): TerminalSyncState {
  return {
    sid,
    phase: 'live',
    lastSeq,
    snapshotRequested: false,
    buffered: new Map(),
  };
}

describe('terminalSync', () => {
  it('writes only the next sequence and drops duplicate or stale chunks', () => {
    const live = syncedState('s1', 8);
    expect(applyTerminalChunk(live, chunk(9, 'new')).effects).toEqual([
      { type: 'write', data: 'new' },
    ]);
    expect(applyTerminalChunk(live, chunk(8, 'duplicate')).effects).toEqual([]);
  });

  it('requests one snapshot on a gap and buffers the tail', () => {
    const first = applyTerminalChunk(syncedState('s1', 8), chunk(11, 'eleven'));
    expect(first.effects).toEqual([{ type: 'requestSnapshot', sid: 's1' }]);
    const second = applyTerminalChunk(first.state, chunk(12, 'twelve'));
    expect(second.effects).toEqual([]);
  });

  it('replaces once then drains only the contiguous post-snapshot tail', () => {
    let syncing = beginTerminalSync('s1');
    syncing = applyTerminalChunk(syncing, chunk(11, 'eleven')).state;
    syncing = applyTerminalChunk(syncing, chunk(10, 'ten')).state;
    const applied = applyTerminalSnapshot(syncing, snapshot(9, 'screen'));
    expect(applied.effects).toEqual([
      { type: 'reset', data: 'screen' },
      { type: 'write', data: 'ten' },
      { type: 'write', data: 'eleven' },
    ]);
    expect(applied.state.lastSeq).toBe(11);
    expect(applied.state.phase).toBe('live');
  });

  it('does not append a stale snapshot over a live screen', () => {
    const result = applyTerminalSnapshot(syncedState('s1', 12), snapshot(9, 'old'));
    expect(result.effects).toEqual([]);
  });

  it('ignores chunks with a non-integer or NaN sequence', () => {
    const live = syncedState('s1', 8);
    expect(applyTerminalChunk(live, chunk(8.5, 'x')).effects).toEqual([]);
    expect(applyTerminalChunk(live, chunk(8.5, 'x')).state).toBe(live);
    expect(applyTerminalChunk(live, chunk(Number.NaN, 'y')).effects).toEqual([]);
  });

  it('ignores a snapshot with a non-integer sequence', () => {
    const live = syncedState('s1', 8);
    expect(applyTerminalSnapshot(live, snapshot(9.5, 'y')).effects).toEqual([]);
    expect(applyTerminalSnapshot(live, snapshot(9.5, 'y')).state).toBe(live);
  });

  it('ignores a chunk for a different session id', () => {
    const live = syncedState('s1', 8);
    expect(applyTerminalChunk(live, chunk(9, 'x', 's2')).effects).toEqual([]);
    expect(applyTerminalChunk(live, chunk(9, 'x', 's2')).state).toBe(live);
  });

  it('ignores a snapshot for a different session id', () => {
    const live = syncedState('s1', 8);
    expect(applyTerminalSnapshot(live, snapshot(20, 'x', 's2')).effects).toEqual([]);
  });

  it('does not request a redundant snapshot for out-of-order chunks after sync already started', () => {
    const state = beginTerminalSync('s1');
    expect(state.snapshotRequested).toBe(true);
    const result = applyTerminalChunk(state, chunk(5, 'five'));
    expect(result.effects).toEqual([]);
    expect(result.state.buffered.get(5)).toBe('five');
  });

  it('keeps the first authoritative bytes for a duplicate buffered sequence and never grows the buffer', () => {
    let state = beginTerminalSync('s1');
    state = applyTerminalChunk(state, chunk(5, 'first')).state;
    const sizeBefore = state.buffered.size;
    state = applyTerminalChunk(state, chunk(5, 'second')).state;
    expect(state.buffered.get(5)).toBe('first');
    expect(state.buffered.size).toBe(sizeBefore);
  });

  it('bounds the buffer to 256 entries and evicts the highest (far-future) sequence on overflow', () => {
    let state = beginTerminalSync('s1');
    for (let seq = 1; seq <= 300; seq += 1) {
      state = applyTerminalChunk(state, chunk(seq, `chunk-${seq}`)).state;
    }
    expect(state.buffered.size).toBe(MAX_BUFFERED_TERMINAL_CHUNKS);
    expect(state.buffered.has(1)).toBe(true);
    expect(state.buffered.has(256)).toBe(true);
    expect(state.buffered.has(257)).toBe(false);
    expect(state.buffered.has(300)).toBe(false);
  });

  it('keeps the lowest sequences nearest lastSeq even when far chunks arrive first', () => {
    let state = beginTerminalSync('s1');
    for (let seq = 1000; seq > 1000 - (MAX_BUFFERED_TERMINAL_CHUNKS + 10); seq -= 1) {
      state = applyTerminalChunk(state, chunk(seq, `chunk-${seq}`)).state;
    }
    expect(state.buffered.size).toBe(MAX_BUFFERED_TERMINAL_CHUNKS);
    expect(state.buffered.has(1000 - (MAX_BUFFERED_TERMINAL_CHUNKS + 10) + 1)).toBe(true);
    expect(state.buffered.has(1000)).toBe(false);
  });

  it('emits exactly one new snapshot request when a gap remains after applying a snapshot', () => {
    let state = beginTerminalSync('s1');
    state = applyTerminalChunk(state, chunk(5, 'five')).state;
    state = applyTerminalChunk(state, chunk(8, 'eight')).state;
    const applied = applyTerminalSnapshot(state, snapshot(4, 'screen'));
    expect(applied.effects).toEqual([
      { type: 'reset', data: 'screen' },
      { type: 'write', data: 'five' },
      { type: 'requestSnapshot', sid: 's1' },
    ]);
    expect(applied.state.phase).toBe('syncing');
    expect(applied.state.snapshotRequested).toBe(true);
    expect(applied.state.lastSeq).toBe(5);
    expect([...applied.state.buffered.keys()]).toEqual([8]);
  });

  it('resets a fresh session with no buffered data and requests exactly one snapshot semantics', () => {
    const state = beginTerminalSync('s1');
    expect(state).toEqual({
      sid: 's1',
      phase: 'syncing',
      lastSeq: -1,
      snapshotRequested: true,
      buffered: new Map(),
    });
  });

  it('discards old-session buffered data on a session switch', () => {
    let s1 = beginTerminalSync('s1');
    s1 = applyTerminalChunk(s1, chunk(4, 'buffered-for-s1')).state;
    expect(s1.buffered.size).toBe(1);

    const s2 = beginTerminalSync('s2');
    expect(s2.sid).toBe('s2');
    expect(s2.buffered.size).toBe(0);
    expect(s2.phase).toBe('syncing');
    expect(s2.snapshotRequested).toBe(true);
    expect(s2.lastSeq).toBe(-1);

    // A stale chunk still addressed to the old session must not affect the new one.
    expect(applyTerminalChunk(s2, chunk(4, 'stale-for-s1', 's1')).effects).toEqual([]);
    expect(applyTerminalChunk(s2, chunk(4, 'stale-for-s1', 's1')).state).toBe(s2);
  });

  it('resets exactly once for a newer snapshot and drains only chunks newer than it', () => {
    let state = beginTerminalSync('s1');
    state = applyTerminalChunk(state, chunk(3, 'three')).state;
    state = applyTerminalChunk(state, chunk(4, 'four')).state;
    const firstSnapshot = applyTerminalSnapshot(state, snapshot(2, 'first-screen'));
    expect(firstSnapshot.effects).toEqual([
      { type: 'reset', data: 'first-screen' },
      { type: 'write', data: 'three' },
      { type: 'write', data: 'four' },
    ]);
    expect(firstSnapshot.state.phase).toBe('live');

    // A late/duplicate response to the earlier request must not repaint over live output.
    const staleReplay = applyTerminalSnapshot(firstSnapshot.state, snapshot(2, 'first-screen'));
    expect(staleReplay.effects).toEqual([]);
  });
});
