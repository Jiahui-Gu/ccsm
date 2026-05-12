/**
 * S4-T5 (Task #136): cf-worker JWT routing middleware unit tests.
 *
 * Pure helper coverage — no DO / no fetch handler. We exercise:
 *   - getAuthMode env-var gating (default legacy / explicit jwt / typo)
 *   - getUserDoIdName format
 *   - extractWebJwt: ws subprotocol, Authorization Bearer, missing,
 *     expired, wrong-key, wrong-kind (tunnel JWT presented at web path)
 *   - extractTunnelJwt: subprotocol-only path + wrong-kind rejection
 *
 * Uses the same KEY_A/KEY_B pattern as jwt.test.ts — 32-byte hex keys.
 */
import { describe, expect, it } from 'vitest';
import {
  extractTunnelJwt,
  extractWebJwt,
  getAuthMode,
  getUserDoIdName,
} from '../src/auth/middleware';
import {
  signJwt,
  type TunnelJwtClaims,
  type WebJwtClaims,
} from '../src/auth/jwt';
import type { AuthEnv } from '../src/auth/bindings';

const KEY_WEB =
  '11112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_TUNNEL =
  '22ee'.repeat(16);

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    TUNNEL: undefined as unknown as DurableObjectNamespace,
    USER_DO: undefined as unknown as DurableObjectNamespace,
    GITHUB_OAUTH_CLIENT_ID: 'iv1.test',
    GITHUB_OAUTH_CLIENT_SECRET: 'shh',
    JWT_SIGNING_KEY: KEY_WEB,
    JWT_REFRESH_SIGNING_KEY: KEY_TUNNEL,
    CCSM_AUTH_MODE: undefined,
    ...overrides,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function makeWebClaims(over: Partial<WebJwtClaims> = {}): WebJwtClaims {
  return {
    sub: '12345',
    login: 'octocat',
    iat: nowSec() - 1,
    exp: nowSec() + 60,
    kind: 'web',
    ...over,
  };
}

function makeTunnelClaims(over: Partial<TunnelJwtClaims> = {}): TunnelJwtClaims {
  return {
    sub: '12345',
    login: 'octocat',
    iat: nowSec() - 1,
    exp: nowSec() + 3600,
    kind: 'tunnel',
    jti: 't-abc',
    ...over,
  };
}

describe('getAuthMode', () => {
  it('defaults to legacy when unset', () => {
    expect(getAuthMode({})).toBe('legacy');
    expect(getAuthMode({ CCSM_AUTH_MODE: undefined })).toBe('legacy');
  });
  it('returns jwt when explicitly "jwt"', () => {
    expect(getAuthMode({ CCSM_AUTH_MODE: 'jwt' })).toBe('jwt');
  });
  it('returns legacy on the literal value "legacy" or empty string', () => {
    expect(getAuthMode({ CCSM_AUTH_MODE: 'legacy' })).toBe('legacy');
    expect(getAuthMode({ CCSM_AUTH_MODE: '' })).toBe('legacy');
  });
  it('audit F-S-3: throws on unrecognized non-empty values (no silent fallback)', () => {
    // Pre-audit behaviour: getAuthMode silently returned 'legacy' when the
    // env var was a typo (e.g. 'JWT' upper-case). That meant a misconfigured
    // wrangler vars deploy quietly skipped JWT enforcement. Audit F-S-3
    // tightens the gate: anything other than the recognized literals
    // throws so the worker fails closed at startup.
    expect(() => getAuthMode({ CCSM_AUTH_MODE: 'JWT' })).toThrowError(/CCSM_AUTH_MODE/);
    expect(() => getAuthMode({ CCSM_AUTH_MODE: 'enabled' })).toThrowError(/CCSM_AUTH_MODE/);
    expect(() => getAuthMode({ CCSM_AUTH_MODE: 'on' })).toThrowError(/CCSM_AUTH_MODE/);
  });
});

describe('getUserDoIdName', () => {
  it('namespaces user_id under user: prefix', () => {
    expect(getUserDoIdName('12345')).toBe('user:12345');
    expect(getUserDoIdName('99')).toBe('user:99');
  });
  it('different ids produce different names (DO isolation)', () => {
    expect(getUserDoIdName('1')).not.toBe(getUserDoIdName('2'));
  });
});

describe('extractWebJwt', () => {
  it('extracts from Sec-WebSocket-Protocol ccsm.<jwt>', async () => {
    const claims = makeWebClaims();
    const tok = await signJwt(claims, KEY_WEB);
    const req = new Request('http://x/ws/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).not.toBeNull();
    expect(out!.login).toBe('octocat');
    expect(out!.sub).toBe('12345');
  });

  it('extracts from Authorization: Bearer header', async () => {
    const tok = await signJwt(makeWebClaims(), KEY_WEB);
    const req = new Request('http://x/api/sessions', {
      headers: { Authorization: 'Bearer ' + tok },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('web');
  });

  it('returns null when no token header present', async () => {
    const req = new Request('http://x/api/sessions');
    const out = await extractWebJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('returns null on expired token', async () => {
    const tok = await signJwt(
      makeWebClaims({ iat: nowSec() - 120, exp: nowSec() - 1 }),
      KEY_WEB,
    );
    const req = new Request('http://x/ws/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('returns null when signed with the wrong key', async () => {
    const tok = await signJwt(makeWebClaims(), KEY_TUNNEL); // wrong key
    const req = new Request('http://x/ws/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('returns null when a tunnel JWT is presented at web path (kind mismatch)', async () => {
    // Token is well-formed and signed with JWT_SIGNING_KEY but kind='tunnel'.
    const claims: TunnelJwtClaims = makeTunnelClaims();
    const tok = await signJwt(claims, KEY_WEB);
    const req = new Request('http://x/ws/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('Sec-WebSocket-Protocol takes precedence over Authorization header', async () => {
    // A real client wouldn't send both, but the code path orders subprotocol
    // first; document that explicitly so a future refactor doesn't flip it.
    const wsTok = await signJwt(makeWebClaims({ login: 'fromWs' }), KEY_WEB);
    const authTok = await signJwt(makeWebClaims({ login: 'fromAuth' }), KEY_WEB);
    const req = new Request('http://x/ws/default', {
      headers: {
        'Sec-WebSocket-Protocol': 'ccsm.' + wsTok,
        Authorization: 'Bearer ' + authTok,
      },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out!.login).toBe('fromWs');
  });

  it('ignores non-ccsm subprotocol entries', async () => {
    const tok = await signJwt(makeWebClaims(), KEY_WEB);
    const req = new Request('http://x/ws/default', {
      headers: { 'Sec-WebSocket-Protocol': 'graphql-ws, ccsm.' + tok + ', json' },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).not.toBeNull();
  });

  it('returns null when ccsm. subprotocol present but token empty', async () => {
    const req = new Request('http://x/ws/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('audit F-S-4: extracts from web_jwt HttpOnly cookie', async () => {
    const tok = await signJwt(makeWebClaims(), KEY_WEB);
    const req = new Request('http://x/api/sessions', {
      headers: { Cookie: `web_jwt=${tok}; other=x` },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('web');
  });

  it('audit F-S-4: cookie takes precedence over subprotocol + Authorization', async () => {
    // Documents the ordering — cookie path is the new default; subprotocol
    // remains for ws upgrades, Bearer for Tauri loopback.
    const cookieTok = await signJwt(makeWebClaims({ login: 'fromCookie' }), KEY_WEB);
    const wsTok = await signJwt(makeWebClaims({ login: 'fromWs' }), KEY_WEB);
    const authTok = await signJwt(makeWebClaims({ login: 'fromAuth' }), KEY_WEB);
    const req = new Request('http://x/api/sessions', {
      headers: {
        Cookie: `web_jwt=${cookieTok}`,
        'Sec-WebSocket-Protocol': 'ccsm.' + wsTok,
        Authorization: 'Bearer ' + authTok,
      },
    });
    const out = await extractWebJwt(req, makeEnv());
    expect(out!.login).toBe('fromCookie');
  });
});

describe('extractTunnelJwt', () => {
  it('extracts a tunnel-kind JWT from subprotocol', async () => {
    const tok = await signJwt(makeTunnelClaims(), KEY_TUNNEL);
    const req = new Request('http://x/tunnel/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractTunnelJwt(req, makeEnv());
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('tunnel');
    expect(out!.jti).toBe('t-abc');
  });

  it('rejects a web-kind JWT presented at tunnel path', async () => {
    // Even if signed with the refresh key, kind='web' must be rejected.
    const tok = await signJwt(makeWebClaims(), KEY_TUNNEL);
    const req = new Request('http://x/tunnel/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractTunnelJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('returns null when subprotocol header missing (Authorization is NOT consulted)', async () => {
    const tok = await signJwt(makeTunnelClaims(), KEY_TUNNEL);
    const req = new Request('http://x/tunnel/default', {
      headers: { Authorization: 'Bearer ' + tok },
    });
    const out = await extractTunnelJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('returns null on expired tunnel token', async () => {
    const tok = await signJwt(
      makeTunnelClaims({ iat: nowSec() - 7200, exp: nowSec() - 60 }),
      KEY_TUNNEL,
    );
    const req = new Request('http://x/tunnel/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractTunnelJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('audit F-S-1: tunnel JWT signed with web key (JWT_SIGNING_KEY) is rejected', async () => {
    // Pre-audit deviceFlow.ts signed tunnel JWTs with `JWT_SIGNING_KEY`
    // while middleware verified against `JWT_REFRESH_SIGNING_KEY` — every
    // legit daemon dial would fail in jwt mode. The fix routes the
    // signing call through `JWT_REFRESH_SIGNING_KEY` (separate key, kept
    // distinct so a leaked web key cannot mint daemon tokens). This
    // guard documents that a token signed with the WRONG key
    // (JWT_SIGNING_KEY) still cannot pass tunnel verification — the key
    // separation invariant holds.
    const tok = await signJwt(makeTunnelClaims(), KEY_WEB); // web key, wrong for tunnel
    const req = new Request('http://x/tunnel/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractTunnelJwt(req, makeEnv());
    expect(out).toBeNull();
  });

  it('audit F-S-1: tunnel JWT signed with refresh key (post-fix) verifies', async () => {
    // Mirror of the above — round-trip with the correct key passes, so
    // the deviceFlow.ts → middleware contract works end-to-end.
    const tok = await signJwt(makeTunnelClaims(), KEY_TUNNEL);
    const req = new Request('http://x/tunnel/default', {
      headers: { 'Sec-WebSocket-Protocol': 'ccsm.' + tok },
    });
    const out = await extractTunnelJwt(req, makeEnv());
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('tunnel');
  });
});
