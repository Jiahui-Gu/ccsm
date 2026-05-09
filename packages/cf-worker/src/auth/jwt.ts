/**
 * S4-T2 (Task #121): HS256 JWT helpers for the cf-worker auth subsystem.
 *
 * Implemented with the SubtleCrypto WebCrypto API (no new npm dep). HS256
 * matches the GitHub OAuth + per-tunnel JWT design locked in S4 D1-D5.
 *
 * Two claim shapes:
 *   - WebJwtClaims  — short-lived browser session token (kind: 'web')
 *   - TunnelJwtClaims — per-tunnel daemon-presented token (kind: 'tunnel')
 *
 * Key separation invariant (audit F-S-1, Task #152):
 *   - kind='web' tokens MUST be signed AND verified with `JWT_SIGNING_KEY`.
 *   - kind='tunnel' tokens MUST be signed AND verified with
 *     `JWT_REFRESH_SIGNING_KEY`.
 *   The two keys live in separate `wrangler secret` slots so a leak of the
 *   web key cannot mint daemon-class tokens (and vice versa). signJwt /
 *   verifyJwt accept any hex key — the caller is responsible for pairing.
 *   See deviceFlow.ts (signs tunnel) + middleware.extractTunnelJwt (verifies
 *   tunnel) and webOauth.ts (signs web) + middleware.extractWebJwt
 *   (verifies web).
 *
 * Keys are passed in as hex strings (matching `wrangler secret` / `.dev.vars`
 * style); we decode to raw bytes inside `importHmacKey`. Sign + verify both
 * round-trip through base64url (RFC 7515 §2). `verifyJwt` is exp-aware (token
 * is rejected if `now >= exp`); a small clock-skew window can be added later
 * when devices re-enter the system.
 *
 * NOT exported / NOT used here: refresh-token rotation, JWK, RS256, kid
 * routing — T3/T4 task scope. This file is pure primitives.
 */

/** Browser session JWT (Task #121, kind='web'). exp/iat in epoch seconds. */
export interface WebJwtClaims {
  sub: string;
  login: string;
  exp: number;
  iat: number;
  kind: 'web';
}

/** Per-tunnel JWT (Task #121, kind='tunnel'). `jti` is the tunnel id. */
export interface TunnelJwtClaims {
  sub: string;
  login: string;
  exp: number;
  iat: number;
  kind: 'tunnel';
  jti: string;
}

/** Any well-formed JWT claim shape with required `exp`. */
type JwtClaims = WebJwtClaims | TunnelJwtClaims;

const HS256_HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('jwt: hex key has odd length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('jwt: invalid hex char in key');
    }
    out[i] = byte;
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function importHmacKey(hexKey: string, usage: KeyUsage): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  return crypto.subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/**
 * Sign a claim set as an HS256 JWT. `claims.exp` / `claims.iat` are NOT auto-
 * filled — caller passes the full claim object. Returns `header.payload.sig`.
 */
export async function signJwt<T extends JwtClaims>(
  claims: T,
  hexKey: string,
): Promise<string> {
  const key = await importHmacKey(hexKey, 'sign');
  const headerB64 = base64urlEncode(enc.encode(JSON.stringify(HS256_HEADER)));
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = headerB64 + '.' + payloadB64;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const sigB64 = base64urlEncode(new Uint8Array(sig));
  return signingInput + '.' + sigB64;
}

/**
 * Verify an HS256 JWT and return the decoded claims, or `null` if anything
 * fails (bad shape, bad signature, expired). The caller is responsible for
 * narrowing the resulting type via `kind` discriminant — verifyJwt does NOT
 * inspect `kind`, only `exp`.
 */
export async function verifyJwt<T extends JwtClaims>(
  token: string,
  hexKey: string,
): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  if (headerB64.length === 0 || payloadB64.length === 0 || sigB64.length === 0) {
    return null;
  }

  let key: CryptoKey;
  try {
    key = await importHmacKey(hexKey, 'verify');
  } catch {
    return null;
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64urlDecode(sigB64);
  } catch {
    return null;
  }

  const signingInput = enc.encode(headerB64 + '.' + payloadB64);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify('HMAC', key, sigBytes as unknown as BufferSource, signingInput);
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(dec.decode(base64urlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const claims = payload as Record<string, unknown>;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec >= claims.exp) return null;

  return claims as unknown as T;
}
