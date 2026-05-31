// src/mobile/__tests__/protocol.test.ts
import { describe, it, expect } from 'vitest';
import type {
  SessionListEntry,
  PhoneToDesktop,
  DesktopToPhone,
  SignalRegister,
  SignalOffer,
  SignalAnswer,
  SignalIce,
} from '../protocol';

describe('protocol wire shapes', () => {
  it('terminal client→desktop messages serialize with required fields', () => {
    const input: PhoneToDesktop = { type: 'session.input', sid: 's1', data: 'ls\r' };
    const resize: PhoneToDesktop = { type: 'session.resize', sid: 's1', cols: 80, rows: 24 };
    const snap: PhoneToDesktop = { type: 'session.snapshot', sid: 's1' };
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
    expect(JSON.parse(JSON.stringify(resize))).toEqual(resize);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('terminal desktop→phone messages carry the fields the xterm UI reads', () => {
    const list: DesktopToPhone = {
      type: 'sessions.list',
      sessions: [{ sid: 's1', cwd: '/repo', cols: 80, rows: 24 } satisfies SessionListEntry],
    };
    const data: DesktopToPhone = { type: 'pty.data', sid: 's1', chunk: 'x', seq: 7 };
    expect(list.sessions[0]!.sid).toBe('s1');
    expect(data.seq).toBe(7);
  });

  it('signaling messages mirror the PR-1 DO schema (§6.3)', () => {
    const reg: SignalRegister = { type: 'register', role: 'phone', peerId: 'p1' };
    const offer: SignalOffer = { type: 'offer', to: 'd1', from: 'p1', sdp: 'v=0...' };
    const answer: SignalAnswer = { type: 'answer', to: 'p1', from: 'd1', sdp: 'v=0...' };
    const ice: SignalIce = { type: 'ice', to: 'd1', from: 'p1', candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 };
    expect(reg.role).toBe('phone');
    expect(offer.to).toBe('d1');
    expect(answer.from).toBe('d1');
    expect(ice.sdpMLineIndex).toBe(0);
  });
});
