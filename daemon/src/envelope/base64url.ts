import { Buffer } from 'node:buffer';

const BASE64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

export function encode(buf: Buffer): string {
  return buf.toString('base64url');
}

export function decode(s: string): Buffer {
  if (typeof s !== 'string' || !BASE64URL_RE.test(s)) {
    throw new Error('base64url: invalid input');
  }
  // Node accepts both padded and unpadded base64url; normalise to no-padding
  // first so we control what gets re-padded and reject garbage like `===`.
  const stripped = s.replace(/=+$/, '');
  const pad = (4 - (stripped.length % 4)) % 4;
  if (pad === 3) {
    // Length % 4 === 1 is never a valid base64url payload.
    throw new Error('base64url: invalid input length');
  }
  return Buffer.from(stripped + '='.repeat(pad), 'base64url');
}
