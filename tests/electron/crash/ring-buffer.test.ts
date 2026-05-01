// tests/electron/crash/ring-buffer.test.ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../../electron/crash/ring-buffer';

describe('RingBuffer', () => {
  it('keeps last N entries', () => {
    const r = new RingBuffer<string>(3);
    r.push('a'); r.push('b'); r.push('c'); r.push('d');
    expect(r.snapshot()).toEqual(['b', 'c', 'd']);
  });
  it('snapshot is a copy', () => {
    const r = new RingBuffer<string>(2);
    r.push('a');
    const snap = r.snapshot();
    r.push('b');
    expect(snap).toEqual(['a']);
  });
});
