import { describe, expect, it } from 'vitest';

import {
  applyServerMessage,
  controlInput,
  emptyPhoneState,
  selectSession,
  type MobileServerMessage,
} from '../../src/mobile/phoneApp';

describe('phone protocol state', () => {
  it('starts a session sync and queues exactly one session.snapshot request', () => {
    const selected = selectSession(emptyPhoneState(), 's1');

    expect(selected.commands).toEqual([{ type: 'session.snapshot', sid: 's1' }]);
    expect(selected.terminalEffects).toEqual([]);
    expect(selected.state.activeSid).toBe('s1');
    expect(selected.state.terminalSync.sid).toBe('s1');
    expect(selected.state.terminalSync.phase).toBe('syncing');
    expect(selected.state.terminalSync.snapshotRequested).toBe(true);
  });

  it('repaints a selected session from its authoritative snapshot', () => {
    const selected = selectSession(emptyPhoneState(), 's1');
    const repainted = applyServerMessage(selected.state, {
      type: 'session.snapshot',
      sid: 's1',
      seq: 4,
      snapshot: 'screen',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });

    expect(repainted.terminalEffects).toEqual([{
      type: 'installSnapshot',
      sid: 's1',
      seq: 4,
      snapshot: 'screen',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    }]);
    expect(repainted.commands).toEqual([]);
    expect(repainted.state.terminalSync.phase).toBe('live');
    expect(repainted.state.terminalSync.lastSeq).toBe(4);
  });

  it('writes only the next live sequence and drops a duplicate chunk', () => {
    const selected = selectSession(emptyPhoneState(), 's1');
    const live = applyServerMessage(selected.state, {
      type: 'session.snapshot',
      sid: 's1',
      seq: 8,
      snapshot: 'full',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });

    const duplicate = applyServerMessage(live.state, {
      type: 'pty.data',
      sid: 's1',
      seq: 8,
      chunk: 'duplicate',
      geometryEpoch: 0,
    });
    expect(duplicate.terminalEffects).toEqual([]);
    expect(duplicate.commands).toEqual([]);

    const next = applyServerMessage(live.state, {
      type: 'pty.data',
      sid: 's1',
      seq: 9,
      chunk: 'new',
      geometryEpoch: 0,
    });
    expect(next.terminalEffects).toEqual([
      { type: 'write', sid: 's1', seq: 9, data: 'new' },
    ]);

    const duplicateLive = applyServerMessage(next.state, {
      type: 'pty.data',
      sid: 's1',
      seq: 9,
      chunk: 'duplicate-live',
      geometryEpoch: 0,
    });
    expect(duplicateLive.terminalEffects).toEqual([]);
  });

  it('requests exactly one snapshot for a live gap and queues the matching command', () => {
    const selected = selectSession(emptyPhoneState(), 's1');
    const live = applyServerMessage(selected.state, {
      type: 'session.snapshot',
      sid: 's1',
      seq: 8,
      snapshot: 'full',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });

    const gapped = applyServerMessage(live.state, {
      type: 'pty.data',
      sid: 's1',
      seq: 11,
      chunk: 'eleven',
      geometryEpoch: 0,
    });
    expect(gapped.terminalEffects).toEqual([
      { type: 'requestSnapshot', sid: 's1', reason: 'sequence-gap' },
    ]);
    expect(gapped.commands).toEqual([{ type: 'session.snapshot', sid: 's1' }]);
    expect(gapped.state.terminalSync.phase).toBe('syncing');

    const tail = applyServerMessage(gapped.state, {
      type: 'pty.data',
      sid: 's1',
      seq: 12,
      chunk: 'twelve',
      geometryEpoch: 0,
    });
    expect(tail.terminalEffects).toEqual([]);
    expect(tail.commands).toEqual([]);
  });

  it('applies sessions.list with no terminal effects or commands', () => {
    const message: MobileServerMessage = {
      type: 'sessions.list',
      sessions: [{ sid: 's1', cwd: '/repo', geometry: { cols: 80, rows: 24, epoch: 0 } }],
    };
    const result = applyServerMessage(emptyPhoneState(), message);

    expect(result.state.sessions).toEqual(message.sessions);
    expect(result.terminalEffects).toEqual([]);
    expect(result.commands).toEqual([]);
  });

  it('applies shared navigator server messages with no terminal effects or commands', () => {
    const navigatorMessage: MobileServerMessage = {
      type: 'sessions.navigator',
      version: 1,
      model: { groups: [], activeSessionId: null },
    };
    const result = applyServerMessage(emptyPhoneState(), navigatorMessage);

    expect(result.state.navigator).toEqual(navigatorMessage.model);
    expect(result.terminalEffects).toEqual([]);
    expect(result.commands).toEqual([]);
  });

  it('resets buffered sync state for the previous session on a session switch', () => {
    const first = selectSession(emptyPhoneState(), 's1');
    const gapped = applyServerMessage(
      applyServerMessage(first.state, {
        type: 'session.snapshot',
        sid: 's1',
        seq: 1,
        snapshot: 'first-screen',
        geometry: { cols: 80, rows: 24, epoch: 0 },
      }).state,
      {
        type: 'pty.data',
        sid: 's1',
        seq: 4,
        chunk: 'gap-for-s1',
        geometryEpoch: 0,
      },
    );
    expect(gapped.state.terminalSync.buffered.size).toBe(1);

    const switched = selectSession(gapped.state, 's2');
    expect(switched.state.terminalSync.sid).toBe('s2');
    expect(switched.state.terminalSync.buffered.size).toBe(0);
    expect(switched.commands).toEqual([{ type: 'session.snapshot', sid: 's2' }]);

    const staleChunk = applyServerMessage(switched.state, {
      type: 'pty.data',
      sid: 's1',
      seq: 4,
      chunk: 'stale-for-s1',
      geometryEpoch: 0,
    });
    expect(staleChunk.terminalEffects).toEqual([]);
  });

  it('applies sticky Ctrl once to ASCII letters', () => {
    expect(controlInput('a', true)).toEqual({ data: '\x01', ctrlSticky: false });
    expect(controlInput('Z', true)).toEqual({ data: '\x1a', ctrlSticky: false });
    expect(controlInput('1', true)).toEqual({ data: '1', ctrlSticky: false });
  });
});
