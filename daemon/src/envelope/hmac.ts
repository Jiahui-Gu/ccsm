import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encode as base64urlEncode, decode as base64urlDecode } from './base64url.js';

/**
 * L1 envelope HMAC primitives.
 *
 * Per `docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md`
 * §3.4.1.g, the daemon proves possession of `daemon.secret` by HMAC-SHA256
 * over a 16-byte client nonce, truncated to 16 bytes and base64url-encoded
 * (~22 chars on the wire). Verification MUST go through `crypto.timingSafeEqual`
 * to keep the constant-time path wired.
 *
 * This module is intentionally a pure cryptographic primitive: no envelope,
 * socket, or handshake awareness lives here. Higher layers (handshake,
 * interceptor, RPC) compose these helpers.
 */

export const HMAC_ALGO = 'sha256' as const;

/** Number of random bytes in a nonce (also the truncation width of an HMAC tag). */
export const NONCE_BYTES = 16 as const;

/** base64url(no-padding) length of any 16-byte input: ceil(16 * 4 / 3) = 22. */
export const HMAC_TAG_LENGTH = 22 as const;

/**
 * Generate a fresh per-connection challenge nonce.
 *
 * 16 random bytes from `crypto.randomBytes`, encoded as base64url with no
 * padding. Always exactly {@link HMAC_TAG_LENGTH} characters wide.
 */
export function generateNonce(): string {
  return base64urlEncode(randomBytes(NONCE_BYTES));
}

/**
 * Compute HMAC-SHA256 of `payload` under `key`, truncated to
 * {@link NONCE_BYTES} (16) bytes and returned as a base64url-22 string.
 */
export function computeHmac(key: Buffer, payload: Buffer | string): string {
  const mac = createHmac(HMAC_ALGO, key);
  mac.update(payload);
  const full = mac.digest();
  // Truncate to 16 bytes per spec §3.4.1.g ("truncated to 16 bytes, base64").
  const truncated = full.subarray(0, NONCE_BYTES);
  return base64urlEncode(truncated);
}

/**
 * Constant-time HMAC verification.
 *
 * Returns `false` on any mismatch — including length mismatch, garbage tag
 * input, or invalid base64url — without throwing. Equality check is performed
 * exclusively via `crypto.timingSafeEqual` to avoid leaking timing information
 * about which byte differed.
 */
export function verifyHmac(
  key: Buffer,
  payload: Buffer | string,
  tag: string,
): boolean {
  if (typeof tag !== 'string' || tag.length !== HMAC_TAG_LENGTH) {
    return false;
  }

  let provided: Buffer;
  try {
    provided = base64urlDecode(tag);
  } catch {
    return false;
  }

  if (provided.length !== NONCE_BYTES) {
    return false;
  }

  const expected = base64urlDecode(computeHmac(key, payload));

  // Both buffers are guaranteed NONCE_BYTES long here, but guard anyway: a
  // length-mismatched call to timingSafeEqual throws synchronously.
  if (provided.length !== expected.length) {
    return false;
  }

  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}
