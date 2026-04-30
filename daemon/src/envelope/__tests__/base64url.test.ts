import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { encode, decode } from '../base64url.js';

describe('base64url', () => {
  const sizes = [0, 1, 7, 16, 22, 32];

  for (const n of sizes) {
    it(`round-trips ${n}-byte buffer`, () => {
      const input = n === 0 ? Buffer.alloc(0) : randomBytes(n);
      const encoded = encode(input);
      const decoded = decode(encoded);
      expect(decoded.equals(input)).toBe(true);
    });
  }

  it('emits no `=` padding on output', () => {
    for (const n of sizes) {
      const input = n === 0 ? Buffer.alloc(0) : randomBytes(n);
      expect(encode(input)).not.toMatch(/=/);
    }
  });

  it('uses base64url alphabet (no `+` or `/`)', () => {
    // Bytes 0xfb, 0xff produce `+` / `/` under standard base64; ensure we map
    // them to `-` / `_` instead.
    const buf = Buffer.from([0xfb, 0xff, 0xbf]);
    const out = encode(buf);
    expect(out).not.toMatch(/[+/]/);
    expect(decode(out).equals(buf)).toBe(true);
  });

  it('decode tolerates input WITH padding', () => {
    const input = Buffer.from('hello'); // 5 bytes -> base64 needs 1 `=`
    const unpadded = encode(input);
    const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
    expect(padded).toMatch(/=$/);
    expect(decode(padded).equals(input)).toBe(true);
    expect(decode(unpadded).equals(input)).toBe(true);
  });

  it('decode rejects garbage characters', () => {
    expect(() => decode('!@#')).toThrow(/invalid input/);
    expect(() => decode('abc$')).toThrow(/invalid input/);
    expect(() => decode('héllo')).toThrow(/invalid input/);
  });

  it('decode rejects invalid length', () => {
    // length % 4 === 1 is impossible for any valid base64 payload
    expect(() => decode('a')).toThrow(/invalid input length/);
    expect(() => decode('abcde')).toThrow(/invalid input length/);
  });

  it('decode handles empty string', () => {
    expect(decode('').length).toBe(0);
  });
});
