import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../ptyHost', () => ({
  listPtySessions: vi.fn(() => [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24, pid: 1 }]),
  getBufferSnapshot: vi.fn(async () => ({ data: 'hello', seq: 0 })),
  getPtySession: vi.fn(() => ({ cols: 80, rows: 24 })),
  inputPtySession: vi.fn(),
  resizePtySession: vi.fn(),
  onPtyData: vi.fn(() => () => {}),
}));

import { handleClientMessage } from '../remoteMessages';
import type { PeerClient } from '../peerClient';
import { inputPtySession } from '../../ptyHost';

function makeFakeClient(): PeerClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, subscribedSid: null, send: (p) => sent.push(p) };
}

describe('handleClientMessage over PeerClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers sessions.list', async () => {
    const c = makeFakeClient();
    await handleClientMessage(c, JSON.stringify({ type: 'sessions.list' }));
    expect(c.sent).toEqual([{ type: 'sessions.list', sessions: [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24 }] }]);
  });

  it('routes session.input to ptyHost', async () => {
    const c = makeFakeClient();
    await handleClientMessage(c, JSON.stringify({ type: 'session.input', sid: 's1', data: 'x' }));
    expect(inputPtySession).toHaveBeenCalledWith('s1', 'x');
  });

  it('records subscribedSid on snapshot', async () => {
    const c = makeFakeClient();
    await handleClientMessage(c, JSON.stringify({ type: 'session.snapshot', sid: 's1' }));
    expect(c.subscribedSid).toBe('s1');
  });
});
