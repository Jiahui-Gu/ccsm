/**
 * S4-T9 (Task #135): HS256 JWT minting helper for the cross-user isolation
 * harness.
 *
 * Mirrors `packages/cf-worker/src/auth/jwt.ts:signJwt` so the worker (which
 * verifies with `verifyJwt`) accepts these tokens as if they were minted by
 * the OAuth callback path. We re-implement here (rather than importing from
 * the worker package) because:
 *
 *   1. cloud-e2e lives OUTSIDE the pnpm workspace on purpose (see this dir's
 *      package.json + the comment in playwright.config.ts) — pulling in the
 *      worker source would re-link the harness into the monorepo install
 *      graph and defeat the standalone property.
 *   2. The worker uses SubtleCrypto (Workers runtime); Node 22's
 *      `crypto.createHmac` is functionally equivalent for HS256 and ships
 *      with the standard library so we add zero dependencies.
 *
 * Wire format identical to RFC 7515: `base64url(header).base64url(payload).
 * base64url(sig)` where sig is `HMAC-SHA256(signingInput, hexKey→bytes)`.
 *
 * Used ONLY by `specs/cross-user-isolation.spec.ts` to stand in for the
 * GitHub OAuth web-callback (skip OAuth in T9 because T5 vitest already
 * covers the OAuth flow end-to-end; T9 is about prod-like wrangler dev DO
 * cross-user isolation, not the device-flow / web-callback path).
 */
import { createHmac } from 'node:crypto';

/** Browser session JWT (matches cf-worker WebJwtClaims, kind='web'). */
export interface WebJwtClaims {
  sub: string;
  login: string;
  exp: number;
  iat: number;
  kind: 'web';
}

/** Per-tunnel JWT (matches cf-worker TunnelJwtClaims, kind='tunnel'). */
export interface TunnelJwtClaims {
  sub: string;
  login: string;
  exp: number;
  iat: number;
  kind: 'tunnel';
  jti: string;
}

const HS256_HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('jwt-sign: hex key has odd length');
  }
  return Buffer.from(clean, 'hex');
}

/**
 * Sign an HS256 JWT. `claims.exp` / `claims.iat` are NOT auto-filled —
 * caller passes the full claim object. Returns `header.payload.sig`.
 *
 * `hexKey` matches the worker's `.dev.vars` style (raw bytes encoded as
 * lowercase hex, no `0x` prefix). Worker imports the same hex via
 * `importHmacKey` in `auth/jwt.ts`, so as long as the hex strings match
 * verbatim the signature round-trips.
 */
export function signJwt(
  claims: WebJwtClaims | TunnelJwtClaims,
  hexKey: string,
): string {
  const header = base64url(Buffer.from(JSON.stringify(HS256_HEADER), 'utf8'));
  const payload = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signingInput = header + '.' + payload;
  const sig = base64url(
    createHmac('sha256', hexToBytes(hexKey)).update(signingInput).digest(),
  );
  return signingInput + '.' + sig;
}

/**
 * Convenience: sign a `kind:'web'` JWT for `sub` / `login` valid for
 * `lifetimeSec` seconds (default 5 minutes — long enough for the harness,
 * short enough to surface clock-skew bugs).
 */
export function signWebJwt(
  sub: string,
  login: string,
  hexKey: string,
  lifetimeSec = 300,
): string {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt(
    { sub, login, iat, exp: iat + lifetimeSec, kind: 'web' },
    hexKey,
  );
}

/**
 * Convenience: sign a `kind:'tunnel'` JWT. `jti` defaults to a random hex id
 * matching the worker's per-tunnel id shape (T4 device-flow mints `jti=uuid`).
 */
export function signTunnelJwt(
  sub: string,
  login: string,
  hexKey: string,
  lifetimeSec = 3600,
  jti?: string,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const id = jti ?? 'tun-' + Math.random().toString(16).slice(2, 10);
  return signJwt(
    { sub, login, iat, exp: iat + lifetimeSec, kind: 'tunnel', jti: id },
    hexKey,
  );
}
