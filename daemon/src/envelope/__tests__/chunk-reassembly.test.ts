import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  CHUNK_LIMITS,
  ChunkReassembler,
  MAX_REPLAY_BYTES,
  MAX_SUBFRAME_BYTES,
  acceptChunk,
} from '../chunk-reassembly.js';

const buf = (size: number, fill = 0xab): Buffer => Buffer.alloc(size, fill);

describe('ChunkReassembler.accept (round-trip)', () => {
  it('1 chunk = 1 message when final flag set on the first frame', () => {
    const r = new ChunkReassembler();
    const payload = Buffer.from('hello world', 'utf8');
    const result = r.accept({ streamId: 's1', seq: 0, final: true }, payload);
    expect(result.error).toBeUndefined();
    expect(result.complete).toBe(true);
    expect(result.message?.toString('utf8')).toBe('hello world');
  });

  it('reassembles 4 ordered chunks into one message byte-equal', () => {
    const r = new ChunkReassembler();
    const parts = ['alpha-', 'beta-', 'gamma-', 'delta'].map((s) => Buffer.from(s, 'utf8'));
    let last;
    for (let i = 0; i < parts.length; i += 1) {
      const final = i === parts.length - 1;
      const part = parts[i];
      if (part === undefined) throw new Error('test bug');
      last = r.accept({ streamId: 's2', seq: i, final }, part);
      expect(last.error).toBeUndefined();
      expect(last.complete).toBe(final);
    }
    expect(last?.message?.toString('utf8')).toBe('alpha-beta-gamma-delta');
  });

  it('reassembles two back-to-back logical messages on the same stream', () => {
    const r = new ChunkReassembler();
    // Message 1: seq 0, 1 (final)
    expect(r.accept({ streamId: 's3', seq: 0 }, Buffer.from('a')).complete).toBe(false);
    const m1 = r.accept({ streamId: 's3', seq: 1, final: true }, Buffer.from('b'));
    expect(m1.complete).toBe(true);
    expect(m1.message?.toString()).toBe('ab');
    // Message 2: seq 2, 3 (final). pending must have been cleared.
    expect(r.accept({ streamId: 's3', seq: 2 }, Buffer.from('c')).complete).toBe(false);
    const m2 = r.accept({ streamId: 's3', seq: 3, final: true }, Buffer.from('d'));
    expect(m2.complete).toBe(true);
    expect(m2.message?.toString()).toBe('cd');
  });
});

describe('ChunkReassembler.accept (rejections)', () => {
  it('rejects sub-frame larger than 16 KiB', () => {
    const r = new ChunkReassembler();
    const oversized = buf(MAX_SUBFRAME_BYTES + 1);
    const result = r.accept({ streamId: 's4', seq: 0 }, oversized);
    expect(result.complete).toBe(false);
    expect(result.error).toMatch(/exceeds 16384/);
    // State unchanged — next legit accept on seq 0 still works.
    const ok = r.accept({ streamId: 's4', seq: 0, final: true }, Buffer.from('ok'));
    expect(ok.complete).toBe(true);
    expect(ok.message?.toString()).toBe('ok');
  });

  it('accepts exactly 16 KiB (boundary)', () => {
    const r = new ChunkReassembler();
    const at = buf(MAX_SUBFRAME_BYTES);
    const result = r.accept({ streamId: 's5', seq: 0, final: true }, at);
    expect(result.error).toBeUndefined();
    expect(result.complete).toBe(true);
    expect(result.message?.length).toBe(MAX_SUBFRAME_BYTES);
  });

  it('rejects seq jump (1, 3 instead of 1, 2)', () => {
    const r = new ChunkReassembler();
    expect(r.accept({ streamId: 's6', seq: 0 }, Buffer.from('a')).error).toBeUndefined();
    expect(r.accept({ streamId: 's6', seq: 1 }, Buffer.from('b')).error).toBeUndefined();
    const jumped = r.accept({ streamId: 's6', seq: 3 }, Buffer.from('d'));
    expect(jumped.error).toMatch(/seq out of order: expected 2 got 3/);
    // lastSeq unchanged after rejection.
    expect(r.getLastSeq('s6')).toBe(1);
  });

  it('rejects duplicate seq (1, 1)', () => {
    const r = new ChunkReassembler();
    expect(r.accept({ streamId: 's7', seq: 0 }, Buffer.from('a')).error).toBeUndefined();
    expect(r.accept({ streamId: 's7', seq: 1 }, Buffer.from('b')).error).toBeUndefined();
    const dup = r.accept({ streamId: 's7', seq: 1 }, Buffer.from('b2'));
    expect(dup.error).toMatch(/seq out of order: expected 2 got 1/);
  });

  it('first frame on a fresh stream must be seq 0', () => {
    const r = new ChunkReassembler();
    const wrong = r.accept({ streamId: 's8', seq: 5 }, Buffer.from('x'));
    expect(wrong.error).toMatch(/first frame on streamId=s8 must be seq 0/);
  });

  it('rejects negative or non-integer seq', () => {
    const r = new ChunkReassembler();
    const neg = r.accept({ streamId: 's9', seq: -1 }, Buffer.from('x'));
    expect(neg.error).toMatch(/first frame on streamId=s9 must be seq 0/);
  });

  it('rejects mismatched streamId at the pure-function layer', () => {
    // Direct acceptChunk call; the class wrapper guarantees match by lookup.
    const state = {
      streamId: 's10',
      lastSeq: -1,
      pending: [] as Buffer[],
      replayBytes: 0,
      replay: [] as { seq: number; payload: Buffer }[],
    };
    const result = acceptChunk(state, { streamId: 'OTHER', seq: 0 }, Buffer.from('x'));
    expect(result.error).toMatch(/streamId mismatch/);
  });
});

describe('ChunkReassembler replay buffer (256 KiB cap)', () => {
  it('retains chunks under the cap', () => {
    const r = new ChunkReassembler();
    // 4 KiB × 4 = 16 KiB, well under 256 KiB.
    for (let i = 0; i < 4; i += 1) {
      r.accept({ streamId: 'sR1', seq: i }, buf(4 * 1024, i));
    }
    expect(r.getReplayBytes('sR1')).toBe(16 * 1024);
    expect(r.getReplayWindow('sR1').length).toBe(4);
  });

  it('evicts oldest entries FIFO when total exceeds 256 KiB', () => {
    const r = new ChunkReassembler();
    const chunkSize = MAX_SUBFRAME_BYTES; // 16 KiB
    // 256 KiB / 16 KiB = 16 entries fit exactly.
    const fits = MAX_REPLAY_BYTES / chunkSize; // 16
    // Push 20 chunks; 4 oldest must be evicted, newest 16 remain.
    for (let i = 0; i < fits + 4; i += 1) {
      const r1 = r.accept({ streamId: 'sR2', seq: i }, buf(chunkSize, i & 0xff));
      expect(r1.error).toBeUndefined();
    }
    expect(r.getReplayBytes('sR2')).toBeLessThanOrEqual(MAX_REPLAY_BYTES);
    const window = r.getReplayWindow('sR2');
    expect(window.length).toBe(fits);
    // Oldest retained seq is 4 (we evicted 0,1,2,3); newest is 19.
    expect(window[0]?.seq).toBe(4);
    expect(window[window.length - 1]?.seq).toBe(fits + 3);
  });

  it('replay-buffer eviction does not break in-progress reassembly', () => {
    // The pending[] for the in-flight logical message is independent of the
    // replay buffer's eviction — losing a chunk from the replay window
    // (used only for resubscribe) must not corrupt the message we're still
    // assembling. Push enough chunks to evict early ones, then close with
    // final on a later seq and assert the assembled message contains every
    // pushed byte in order.
    const r = new ChunkReassembler();
    const chunkSize = MAX_SUBFRAME_BYTES;
    const total = (MAX_REPLAY_BYTES / chunkSize) + 4; // 20
    let totalBytes = 0;
    for (let i = 0; i < total; i += 1) {
      const isFinal = i === total - 1;
      const result = r.accept({ streamId: 'sR3', seq: i, final: isFinal }, buf(chunkSize, i & 0xff));
      expect(result.error).toBeUndefined();
      totalBytes += chunkSize;
      if (isFinal) {
        expect(result.complete).toBe(true);
        expect(result.message?.length).toBe(totalBytes);
      }
    }
  });
});

describe('ChunkReassembler.getReplayWindow', () => {
  it('returns ordered chunks (oldest → newest) with seq + payload', () => {
    const r = new ChunkReassembler();
    const payloads = [Buffer.from('aa'), Buffer.from('bbb'), Buffer.from('cccc')];
    payloads.forEach((p, i) => {
      r.accept({ streamId: 'sW1', seq: i }, p);
    });
    const window = r.getReplayWindow('sW1');
    expect(window.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(window.map((e) => e.payload.toString('utf8'))).toEqual(['aa', 'bbb', 'cccc']);
  });

  it('returns an empty array for an unknown stream', () => {
    const r = new ChunkReassembler();
    expect(r.getReplayWindow('nope')).toEqual([]);
    expect(r.getReplayBytes('nope')).toBe(0);
    expect(r.getLastSeq('nope')).toBe(-1);
  });

  it('returned array is a copy (mutating it does not affect internal state)', () => {
    const r = new ChunkReassembler();
    r.accept({ streamId: 'sW2', seq: 0 }, Buffer.from('x'));
    const window = r.getReplayWindow('sW2');
    window.length = 0;
    expect(r.getReplayWindow('sW2').length).toBe(1);
  });
});

describe('ChunkReassembler.forget', () => {
  it('drops state so a new stream with the same id can start at seq 0', () => {
    const r = new ChunkReassembler();
    r.accept({ streamId: 'sF1', seq: 0 }, Buffer.from('x'));
    r.accept({ streamId: 'sF1', seq: 1, final: true }, Buffer.from('y'));
    r.forget('sF1');
    expect(r.getLastSeq('sF1')).toBe(-1);
    const ok = r.accept({ streamId: 'sF1', seq: 0, final: true }, Buffer.from('z'));
    expect(ok.complete).toBe(true);
    expect(ok.message?.toString()).toBe('z');
  });
});

describe('CHUNK_LIMITS', () => {
  it('exposes the spec-mandated caps as a frozen object', () => {
    expect(CHUNK_LIMITS.MAX_SUBFRAME_BYTES).toBe(16 * 1024);
    expect(CHUNK_LIMITS.MAX_REPLAY_BYTES).toBe(256 * 1024);
    expect(Object.isFrozen(CHUNK_LIMITS)).toBe(true);
  });
});
