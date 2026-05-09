/**
 * S4-T2 (Task #121): JWT helper unit tests.
 *
 * Runs under vitest's default node environment — Node 22 ships globalThis.crypto
 * with SubtleCrypto, the same surface workerd exposes, so the helpers exercise
 * the real WebCrypto path (no shim).
 *
 * Placeholder hex key matches `.dev.vars.example` (32 bytes = 64 hex chars).
 */
import { describe, expect, it } from 'vitest';
import {
  signJwt,
  verifyJwt,
  type WebJwtClaims,
  type TunnelJwtClaims,
} from '../src/auth/jwt';

const KEY_A =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_B =
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe('jwt', () => {
  it('roundtrip: signed web claims verify back to identical payload', async () => {
    const claims: WebJwtClaims = {
      sub: 'gh:12345',
      login: 'octocat',
      iat: nowSec(),
      exp: nowSec() + 60,
      kind: 'web',
    };
    const token = await signJwt(claims, KEY_A);
    expect(token.split('.')).toHaveLength(3);
    const verified = await verifyJwt<WebJwtClaims>(token, KEY_A);
    expect(verified).not.toBeNull();
    expect(verified).toEqual(claims);
  });

  it('roundtrip: tunnel claims with jti round-trip identically', async () => {
    const claims: TunnelJwtClaims = {
      sub: 'gh:12345',
      login: 'octocat',
      iat: nowSec(),
      exp: nowSec() + 3600,
      kind: 'tunnel',
      jti: 'tunnel-uuid-abc',
    };
    const token = await signJwt(claims, KEY_A);
    const verified = await verifyJwt<TunnelJwtClaims>(token, KEY_A);
    expect(verified).toEqual(claims);
  });

  it('expired token (exp <= now) returns null', async () => {
    const claims: WebJwtClaims = {
      sub: 'u',
      login: 'l',
      iat: nowSec() - 120,
      exp: nowSec() - 1,
      kind: 'web',
    };
    const token = await signJwt(claims, KEY_A);
    const verified = await verifyJwt<WebJwtClaims>(token, KEY_A);
    expect(verified).toBeNull();
  });

  it('exp exactly equal to now is rejected (>= exp policy)', async () => {
    const exp = nowSec();
    const claims: WebJwtClaims = {
      sub: 'u',
      login: 'l',
      iat: exp - 60,
      exp,
      kind: 'web',
    };
    const token = await signJwt(claims, KEY_A);
    const verified = await verifyJwt<WebJwtClaims>(token, KEY_A);
    expect(verified).toBeNull();
  });

  it('tampered signature is rejected', async () => {
    const claims: WebJwtClaims = {
      sub: 'u',
      login: 'l',
      iat: nowSec(),
      exp: nowSec() + 60,
      kind: 'web',
    };
    const token = await signJwt(claims, KEY_A);
    const parts = token.split('.');
    // Flip a single base64url char in the signature.
    const sig = parts[2];
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const tampered = parts[0] + '.' + parts[1] + '.' + flipped;
    expect(await verifyJwt(tampered, KEY_A)).toBeNull();
  });

  it('tampered payload (claim mutated) is rejected', async () => {
    const claims: WebJwtClaims = {
      sub: 'u',
      login: 'alice',
      iat: nowSec(),
      exp: nowSec() + 60,
      kind: 'web',
    };
    const token = await signJwt(claims, KEY_A);
    const parts = token.split('.');
    // Substitute a different payload (re-base64url-encoded) but keep the
    // original signature → must fail verify.
    const evil = btoa(JSON.stringify({ ...claims, login: 'mallory' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tampered = parts[0] + '.' + evil + '.' + parts[2];
    expect(await verifyJwt(tampered, KEY_A)).toBeNull();
  });

  it('verify with the wrong key returns null', async () => {
    const claims: WebJwtClaims = {
      sub: 'u',
      login: 'l',
      iat: nowSec(),
      exp: nowSec() + 60,
      kind: 'web',
    };
    const token = await signJwt(claims, KEY_A);
    expect(await verifyJwt(token, KEY_B)).toBeNull();
  });

  it('malformed token (not 3 parts) returns null', async () => {
    expect(await verifyJwt('not.a.valid.jwt', KEY_A)).toBeNull();
    expect(await verifyJwt('twoparts.only', KEY_A)).toBeNull();
    expect(await verifyJwt('', KEY_A)).toBeNull();
  });

  it('invalid hex key returns null (does not throw)', async () => {
    const claims: WebJwtClaims = {
      sub: 'u',
      login: 'l',
      iat: nowSec(),
      exp: nowSec() + 60,
      kind: 'web',
    };
    const token = await signJwt(claims, KEY_A);
    expect(await verifyJwt(token, 'not-hex-zz')).toBeNull();
  });

  it('payload missing exp is rejected', async () => {
    // Manually construct a token with no exp claim, signed with KEY_A.
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = btoa(JSON.stringify({ sub: 'u' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signingInput = header + '.' + payload;
    const keyBytes = new Uint8Array(KEY_A.length / 2);
    for (let i = 0; i < keyBytes.length; i++) {
      keyBytes[i] = parseInt(KEY_A.slice(i * 2, i * 2 + 2), 16);
    }
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(signingInput),
    );
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = signingInput + '.' + sigB64;
    expect(await verifyJwt(token, KEY_A)).toBeNull();
  });
});
