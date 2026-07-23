import { describe, expect, it } from 'vitest';
import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  isMobileClientMessage,
  isMobileServerMessage,
  type MobileServerMessage,
} from '../../src/shared/mobileRemote';

describe('mobile terminal geometry protocol', () => {
  it('uses protocol version 2 and removes phone resize', () => {
    expect(MOBILE_REMOTE_PROTOCOL_VERSION).toBe(2);
    expect(isMobileClientMessage({ type: 'session.resize', sid: 's1', cols: 40, rows: 20 })).toBe(
      false,
    );
  });

  it('accepts sessions.list entries only with required geometry', () => {
    const sessionsListMessage: Extract<MobileServerMessage, { type: 'sessions.list' }> = {
      type: 'sessions.list',
      sessions: [{
        sid: 's1',
        cwd: 'C:\\work',
        geometry: { cols: 120, rows: 30, epoch: 4 },
      }],
    };
    expect(isMobileServerMessage(sessionsListMessage)).toBe(true);
  });

  it('accepts a complete barrier and matching live chunk', () => {
    expect(isMobileServerMessage({
      type: 'session.snapshot',
      sid: 's1',
      seq: 9,
      snapshot: '\u001b[Hready',
      geometry: { cols: 120, rows: 30, epoch: 4 },
    })).toBe(true);
    expect(isMobileServerMessage({
      type: 'pty.data',
      sid: 's1',
      seq: 10,
      chunk: 'tail',
      geometryEpoch: 4,
    })).toBe(true);
  });

  it.each([
    {
      description: 'legacy sessions.list cols/rows aliases',
      message: {
        type: 'sessions.list',
        sessions: [{ sid: 's1', cwd: 'C:\\work', cols: 120, rows: 30 }],
      } as unknown,
    },
    {
      description: 'sessions.list missing geometry',
      message: {
        type: 'sessions.list',
        sessions: [{ sid: 's1', cwd: 'C:\\work' }],
      } as unknown,
    },
    {
      description: 'legacy session.snapshot data and legacy dimensions',
      message: {
        type: 'session.snapshot',
        sid: 's1',
        seq: 9,
        data: '\u001b[Hready',
        cols: 120,
        rows: 30,
      } as unknown,
    },
    {
      description: 'session.snapshot with missing geometry',
      message: {
        type: 'session.snapshot',
        sid: 's1',
        seq: 9,
        snapshot: '\u001b[Hready',
      } as unknown,
    },
    {
      description: 'pty.data without geometryEpoch',
      message: {
        type: 'pty.data',
        sid: 's1',
        seq: 10,
        chunk: 'tail',
      } as unknown,
    },
    {
      description: 'pty.data with unsafe geometryEpoch',
      message: {
        type: 'pty.data',
        sid: 's1',
        seq: 10,
        chunk: 'tail',
        geometryEpoch: -1,
      } as unknown,
    },
  ])('rejects legacy or incomplete server message shapes: $description', ({ message }) => {
    expect(isMobileServerMessage(message)).toBe(false);
  });
});
