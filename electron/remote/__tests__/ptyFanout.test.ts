import { describe, expect, it } from 'vitest';
import { fanoutPtyData } from '../ptyFanout';
import type { PeerClient } from '../peerClient';

function client(subscribedSid: string | null): PeerClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, subscribedSid, send: (p) => sent.push(p) };
}

describe('fanoutPtyData', () => {
  it("delivers a session's bytes only to clients viewing that session", () => {
    const a = client('s1');
    const b = client('s2');
    const c = client(null);
    fanoutPtyData(new Set([a, b, c]), 's1', 'OUT', 7);
    expect(a.sent).toEqual([{ type: 'pty.data', sid: 's1', chunk: 'OUT', seq: 7 }]);
    expect(b.sent).toEqual([]);
    expect(c.sent).toEqual([]);
  });
});
