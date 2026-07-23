import { describe, expect, it } from 'vitest';
import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  isMobileClientMessage,
  isMobileServerMessage,
} from '../../src/shared/mobileRemote';

describe('mobile terminal geometry protocol', () => {
  it('uses protocol version 2 and removes phone resize', () => {
    expect(MOBILE_REMOTE_PROTOCOL_VERSION).toBe(2);
    expect(isMobileClientMessage({ type: 'session.resize', sid: 's1', cols: 40, rows: 20 }))
      .toBe(false);
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
    expect(isMobileServerMessage({
      type: 'sessions.list',
      sessions: [{
        sid: 's1',
        cwd: 'C:\\work',
        geometry: { cols: 120, rows: 30, epoch: 4 },
      }],
    })).toBe(true);
  });

  it.each([
    { cols: 0, rows: 30, epoch: 1 },
    { cols: 80.5, rows: 30, epoch: 1 },
    { cols: 80, rows: 1001, epoch: 1 },
    { cols: 80, rows: 30, epoch: -1 },
  ])('rejects unsafe geometry %#', (geometry) => {
    expect(isMobileServerMessage({
      type: 'session.snapshot',
      sid: 's1',
      seq: 1,
      snapshot: '',
      geometry,
    })).toBe(false);
  });
});
