// Ring buffer unit tests (T8 #661).
//
// Covers RingBuffer in isolation: append round-trip, eviction, wrap-around,
// and edge cases (oversized frame, empty range, fresh-client semantics).

import { describe, expect, it } from 'vitest';
import { RingBuffer, RING_BYTES } from '../src/ring.mjs';

function bytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

describe('RingBuffer', () => {
  it('exposes 4MB default capacity matching DESIGN.md §3', () => {
    expect(RING_BYTES).toBe(4 * 1024 * 1024);
    const r = new RingBuffer();
    expect(r.capacity).toBe(RING_BYTES);
  });

  it('round-trips appended frames via range()', () => {
    const r = new RingBuffer(1024);
    r.append(1, bytes('hello'));
    r.append(2, bytes(' '));
    r.append(3, bytes('world'));
    expect(r.firstSeq).toBe(1);
    expect(r.lastSeq).toBe(3);
    expect(r.byteLength).toBe(11);

    // Full window
    expect(Buffer.from(r.range(1, 3)!).toString('utf8')).toBe('hello world');
    // Tail window (matches the documented "[fromSeq, toSeq] inclusive" contract)
    expect(Buffer.from(r.range(2, 3)!).toString('utf8')).toBe(' world');
    // Single frame
    expect(Buffer.from(r.range(3, 3)!).toString('utf8')).toBe('world');
    // toSeq beyond lastSeq is clamped to lastSeq.
    expect(Buffer.from(r.range(2, 99)!).toString('utf8')).toBe(' world');
    // fromSeq beyond lastSeq -> empty (caller already up to date).
    expect(r.range(99, 200)!.byteLength).toBe(0);
  });

  it('evicts oldest frames when capacity is exceeded', () => {
    const cap = 16;
    const r = new RingBuffer(cap);
    r.append(1, bytes('aaaaa')); // 5
    r.append(2, bytes('bbbbb')); // 10
    r.append(3, bytes('ccccc')); // 15
    expect(r.firstSeq).toBe(1);

    // 5 + 5 + 5 + 5 = 20 > 16 -> evict frame 1 (now 10 used, +5 = 15 OK)
    r.append(4, bytes('ddddd'));
    expect(r.firstSeq).toBe(2);
    expect(r.lastSeq).toBe(4);
    expect(r.range(1, 4)).toBeNull(); // seq 1 was evicted
    expect(Buffer.from(r.range(2, 4)!).toString('utf8')).toBe('bbbbbcccccddddd');

    // Push two more 5-byte frames -> evict 2 then 3.
    r.append(5, bytes('eeeee'));
    r.append(6, bytes('fffff'));
    expect(r.firstSeq).toBe(4);
    expect(r.range(2, 6)).toBeNull();
    expect(Buffer.from(r.range(4, 6)!).toString('utf8')).toBe('dddddeeeeefffff');
  });

  it('handles wrap-around correctly when a frame straddles the buffer end', () => {
    // capacity 10, write enough to wrap and then read a frame that crosses
    // the wrap point.
    const r = new RingBuffer(10);
    r.append(1, bytes('AAAA'));   // [AAAA......] writeOff=4
    r.append(2, bytes('BBBB'));   // [AAAABBBB..] writeOff=8
    // Next 4-byte append needs eviction (8 used + 4 = 12 > 10) -> evict frame 1
    // Then writes 4 bytes starting at writeOff=8 -> wraps: 2 bytes at end, 2 at start.
    r.append(3, bytes('CDEF'));
    expect(r.firstSeq).toBe(2);
    expect(Buffer.from(r.range(3, 3)!).toString('utf8')).toBe('CDEF');
    expect(Buffer.from(r.range(2, 3)!).toString('utf8')).toBe('BBBBCDEF');
  });

  it('rejects a single frame larger than capacity (returns false)', () => {
    const r = new RingBuffer(8);
    expect(r.append(1, new Uint8Array(9))).toBe(false);
    expect(r.firstSeq).toBeNull();
    expect(r.lastSeq).toBeNull();
    // Subsequent normal append still works.
    expect(r.append(2, bytes('xx'))).toBe(true);
    expect(r.lastSeq).toBe(2);
  });

  it('range() on empty buffer returns empty for fresh clients', () => {
    const r = new RingBuffer(64);
    expect(r.range(0, 0)!.byteLength).toBe(0);
    expect(r.range(0, 100)!.byteLength).toBe(0);
  });

  it('range() returns null when fromSeq is older than firstSeq (evicted)', () => {
    const r = new RingBuffer(8);
    r.append(5, bytes('xxxx'));
    r.append(6, bytes('yyyy'));
    r.append(7, bytes('zzzz')); // evicts 5
    expect(r.firstSeq).toBe(6);
    expect(r.range(5, 7)).toBeNull();
    expect(r.range(4, 7)).toBeNull();
  });
});
