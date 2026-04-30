import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  HMAC_ALGO,
  HMAC_TAG_LENGTH,
  NONCE_BYTES,
  computeHmac,
  generateNonce,
  verifyHmac,
} from '../hmac.js';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

describe('hmac constants', () => {
  it('declares sha256 / 16 / 22', () => {
    expect(HMAC_ALGO).toBe('sha256');
    expect(NONCE_BYTES).toBe(16);
    expect(HMAC_TAG_LENGTH).toBe(22);
  });
});

describe('generateNonce', () => {
  it('always returns a 22-char base64url string (100 iterations)', () => {
    for (let i = 0; i < 100; i++) {
      const n = generateNonce();
      expect(n.length).toBe(22);
      expect(n).toMatch(BASE64URL_RE);
      expect(n).not.toMatch(/=/);
    }
  });

  it('uses base64url alphabet only (no `+`, `/`, or `=`)', () => {
    for (let i = 0; i < 50; i++) {
      const n = generateNonce();
      expect(n).not.toMatch(/[+/=]/);
    }
  });

  it('produces distinct nonces across calls (entropy sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateNonce());
    }
    // 100 draws of 128 bits — collision probability is negligible.
    expect(seen.size).toBe(100);
  });
});

describe('computeHmac', () => {
  it('returns a 22-char base64url tag for any payload', () => {
    const key = randomBytes(32);
    const payloads: Array<Buffer | string> = [
      Buffer.alloc(0),
      Buffer.from('hello'),
      'plain string payload',
      randomBytes(1024),
    ];
    for (const p of payloads) {
      const tag = computeHmac(key, p);
      expect(tag.length).toBe(HMAC_TAG_LENGTH);
      expect(tag).toMatch(BASE64URL_RE);
      expect(tag).not.toMatch(/=/);
    }
  });

  it('is deterministic for the same key+payload', () => {
    const key = randomBytes(32);
    const payload = Buffer.from('determinism check');
    expect(computeHmac(key, payload)).toBe(computeHmac(key, payload));
  });

  it('produces the same tag whether payload is Buffer or equivalent string', () => {
    const key = randomBytes(32);
    const s = 'mixed-encoding payload';
    const tagFromString = computeHmac(key, s);
    const tagFromBuffer = computeHmac(key, Buffer.from(s));
    expect(tagFromString).toBe(tagFromBuffer);
  });
});

describe('verifyHmac', () => {
  it('round-trips: compute then verify with same key+payload returns true', () => {
    const key = randomBytes(32);
    const payload = Buffer.from(generateNonce()); // representative 22-char nonce input
    const tag = computeHmac(key, payload);
    expect(verifyHmac(key, payload, tag)).toBe(true);
  });

  it('returns false for the wrong key', () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const payload = Buffer.from('payload bytes');
    const tag = computeHmac(keyA, payload);
    expect(verifyHmac(keyB, payload, tag)).toBe(false);
  });

  it('returns false for the wrong payload', () => {
    const key = randomBytes(32);
    const tag = computeHmac(key, 'original');
    expect(verifyHmac(key, 'tampered', tag)).toBe(false);
  });

  it('returns false (no throw) for a truncated tag', () => {
    const key = randomBytes(32);
    const payload = Buffer.from('abc');
    const tag = computeHmac(key, payload);
    const truncated = tag.slice(0, HMAC_TAG_LENGTH - 1);
    expect(() => verifyHmac(key, payload, truncated)).not.toThrow();
    expect(verifyHmac(key, payload, truncated)).toBe(false);
  });

  it('returns false (no throw) for an over-long tag', () => {
    const key = randomBytes(32);
    const payload = Buffer.from('abc');
    const tag = computeHmac(key, payload) + 'A';
    expect(() => verifyHmac(key, payload, tag)).not.toThrow();
    expect(verifyHmac(key, payload, tag)).toBe(false);
  });

  it('returns false (no throw) for a garbage tag (invalid base64url chars)', () => {
    const key = randomBytes(32);
    const payload = Buffer.from('abc');
    // 22 chars but with `!` and `@` which are outside the base64url alphabet.
    const garbage = '!@#$%^&*()_+{}[]<>?,./';
    expect(garbage.length).toBe(HMAC_TAG_LENGTH);
    expect(() => verifyHmac(key, payload, garbage)).not.toThrow();
    expect(verifyHmac(key, payload, garbage)).toBe(false);
  });

  it('returns false for a one-bit-flipped tag (constant-time path wired)', () => {
    const key = randomBytes(32);
    const payload = Buffer.from('flip-me');
    const tag = computeHmac(key, payload);
    // Flip the first character to a guaranteed-different base64url char.
    const flipped = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
    expect(flipped.length).toBe(HMAC_TAG_LENGTH);
    expect(verifyHmac(key, payload, flipped)).toBe(false);
  });

  it('returns false for non-string tag input', () => {
    const key = randomBytes(32);
    const payload = Buffer.from('abc');
    // @ts-expect-error — runtime guard against callers that bypass the type.
    expect(verifyHmac(key, payload, undefined)).toBe(false);
    // @ts-expect-error — runtime guard against callers that bypass the type.
    expect(verifyHmac(key, payload, null)).toBe(false);
    // @ts-expect-error — runtime guard against callers that bypass the type.
    expect(verifyHmac(key, payload, 12345)).toBe(false);
  });
});
