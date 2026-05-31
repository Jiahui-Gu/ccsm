import { describe, expect, it, vi, beforeEach } from 'vitest';

const inputCalls: Array<[string, string]> = [];
vi.mock('../../ptyHost', () => ({
  listPtySessions: () => [{ sid: 's1', cwd: '/tmp', cols: 80, rows: 24, pid: 1 }],
  getBufferSnapshot: async () => ({ data: '', seq: 0 }),
  getPtySession: () => ({ cols: 80, rows: 24 }),
  inputPtySession: (sid: string, data: string) => { inputCalls.push([sid, data]); },
  resizePtySession: () => {},
}));

import { handleClientMessage } from '../remoteMessages';
import type { PeerClient } from '../peerClient';

const MAX_INPUT_BYTES = 64 * 1024;

function makeClient() {
  return { subscribedSid: null, send: vi.fn() } as unknown as PeerClient & { send: ReturnType<typeof vi.fn> };
}

describe('handleClientMessage session.input cap', () => {
  beforeEach(() => { inputCalls.length = 0; });

  it('forwards input under the cap', async () => {
    const client = makeClient();
    await handleClientMessage(client, JSON.stringify({ type: 'session.input', sid: 's1', data: 'ls\n' }));
    expect(inputCalls).toEqual([['s1', 'ls\n']]);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('rejects input over the cap with input_too_large and does not forward', async () => {
    const client = makeClient();
    const huge = 'x'.repeat(MAX_INPUT_BYTES + 1);
    await handleClientMessage(client, JSON.stringify({ type: 'session.input', sid: 's1', data: huge }));
    expect(inputCalls).toEqual([]);
    expect(client.send).toHaveBeenCalledWith({ type: 'error', message: 'input_too_large' });
  });

  it('accepts input at exactly the cap boundary', async () => {
    const client = makeClient();
    const atCap = 'x'.repeat(MAX_INPUT_BYTES);
    await handleClientMessage(client, JSON.stringify({ type: 'session.input', sid: 's1', data: atCap }));
    expect(inputCalls).toEqual([['s1', atCap]]);
    expect(client.send).not.toHaveBeenCalled();
  });
});
