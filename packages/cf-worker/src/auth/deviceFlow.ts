/**
 * S4-T4 (Task #142): cf-worker GitHub Device Flow handlers.
 *
 * Used by the Tauri/daemon side to obtain a tunnel JWT without opening a
 * browser tab in the renderer. Three endpoints land here:
 *
 *   POST /api/auth/device/start
 *     — kicks off device flow with GitHub
 *       (https://github.com/login/device/code), returns the user_code +
 *       verification_uri + device_code + polling interval to the caller.
 *
 *   POST /api/auth/device/poll      body: { device_code }
 *     — polls GitHub's token endpoint with the
 *       urn:ietf:params:oauth:grant-type:device_code grant. Maps the GitHub
 *       error vocabulary onto a stable `{status: ...}` JSON envelope so the
 *       Tauri side can drive a state machine without parsing GitHub's wire
 *       format directly. On success: persists user, mints a tunnel JWT
 *       (kind='tunnel', 24h) + a 32-byte opaque tunnel refresh token (hash
 *       stored in UserDO under a separate key from web refresh).
 *
 *   POST /api/auth/tunnel/refresh   body: { tunnel_refresh_token }
 *     — verifies the SHA-256 hash against the UserDO tunnel-refresh slot,
 *       rotates: writes a new hash and returns a new tunnel JWT + new
 *       opaque refresh token. Old hash no longer verifies after rotation.
 *
 * Tunnel refresh is intentionally rotated on every refresh (vs. T3 web
 * refresh which keeps the same hash). The daemon already persists tokens
 * to disk, so rotation here is cheap and gives us replay protection.
 *
 * Signing key: tunnel JWTs are signed with `JWT_REFRESH_SIGNING_KEY` so
 * that a leaked `JWT_SIGNING_KEY` (web key) cannot mint daemon-class
 * tokens. middleware.extractTunnelJwt verifies against the same refresh
 * key — the two MUST match (audit F-S-1, Task #152).
 *
 * NOT in scope: the actual TunnelDO routing of the resulting JWT (T5).
 */
import type { AuthEnv } from './bindings';
import { signJwt, type TunnelJwtClaims } from './jwt';

const GH_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GH_USER_URL = 'https://api.github.com/user';

const TUNNEL_JWT_TTL_SEC = 60 * 60 * 24; // 24h
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

function randomHex(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

interface GithubDeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
}

interface GithubTokenPollResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
}

/**
 * POST /api/auth/device/start — proxy to GitHub's device-code endpoint and
 * pass the returned user_code / verification_uri back to the caller.
 */
export async function handleDeviceStart(req: Request, env: AuthEnv): Promise<Response> {
  void req;
  const ghRes = await fetch(GH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      scope: 'read:user',
    }).toString(),
  });
  if (!ghRes.ok) {
    return new Response('github device/code failed', { status: 502 });
  }
  const json = (await ghRes.json()) as GithubDeviceCodeResponse;
  if (
    typeof json.device_code !== 'string' ||
    typeof json.user_code !== 'string' ||
    typeof json.verification_uri !== 'string' ||
    typeof json.expires_in !== 'number' ||
    typeof json.interval !== 'number'
  ) {
    return new Response('github device/code malformed', { status: 502 });
  }
  return Response.json({
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    expires_in: json.expires_in,
    interval: json.interval,
  });
}

/**
 * POST /api/auth/device/poll — single-shot poll. Caller drives the loop
 * (Tauri-side); we just translate the GitHub response into a stable shape.
 */
export async function handleDevicePoll(req: Request, env: AuthEnv): Promise<Response> {
  let body: { device_code?: unknown };
  try {
    body = (await req.json()) as { device_code?: unknown };
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (typeof body.device_code !== 'string' || body.device_code.length === 0) {
    return new Response('missing device_code', { status: 400 });
  }
  const deviceCode = body.device_code;

  const tokenRes = await fetch(GH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    }).toString(),
  });
  if (!tokenRes.ok) {
    return new Response('github device token poll failed', { status: 502 });
  }
  const tokenJson = (await tokenRes.json()) as GithubTokenPollResponse;

  // Pending / slow_down / expired / denied — translate.
  if (tokenJson.error) {
    switch (tokenJson.error) {
      case 'authorization_pending':
        return Response.json({ status: 'pending', interval: tokenJson.interval });
      case 'slow_down':
        // Honor the new interval GitHub gave us.
        return Response.json({ status: 'slow_down', interval: tokenJson.interval });
      case 'expired_token':
        return new Response(JSON.stringify({ status: 'expired' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        });
      case 'access_denied':
        return new Response(JSON.stringify({ status: 'denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      default:
        return new Response(
          JSON.stringify({ status: 'error', error: tokenJson.error }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        );
    }
  }

  if (typeof tokenJson.access_token !== 'string' || tokenJson.access_token.length === 0) {
    return new Response('github device token response malformed', { status: 502 });
  }
  const accessToken = tokenJson.access_token;

  // Fetch the GitHub user identity.
  const userRes = await fetch(GH_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ccsm-cf-worker',
    },
  });
  if (!userRes.ok) {
    return new Response('github user fetch failed', { status: 502 });
  }
  const userJson = (await userRes.json()) as GithubUserResponse;
  if (typeof userJson.id !== 'number' || typeof userJson.login !== 'string') {
    return new Response('github user response malformed', { status: 502 });
  }
  const githubId = String(userJson.id);
  const login = userJson.login;

  // Persist into UserDO.
  const userDoStub = env.USER_DO.get(env.USER_DO.idFromName(login));
  const setLoginRes = await userDoStub.fetch(
    new Request('https://do/setLogin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ github_id: githubId, login }),
    }),
  );
  if (!setLoginRes.ok) {
    return new Response('userDO setLogin failed', { status: 500 });
  }

  // Mint tunnel refresh token + persist hash under the tunnel slot.
  const tunnelRefreshToken = randomHex(32);
  const tunnelRefreshHash = await sha256Hex(tunnelRefreshToken);
  const setHashRes = await userDoStub.fetch(
    new Request('https://do/setTunnelRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: tunnelRefreshHash }),
    }),
  );
  if (!setHashRes.ok) {
    return new Response('userDO setTunnelRefreshTokenHash failed', { status: 500 });
  }

  // Mint tunnel JWT.
  const iat = Math.floor(Date.now() / 1000);
  const claims: TunnelJwtClaims = {
    sub: githubId,
    login,
    iat,
    exp: iat + TUNNEL_JWT_TTL_SEC,
    kind: 'tunnel',
    jti: randomHex(16),
  };
  const tunnelJwt = await signJwt(claims, env.JWT_REFRESH_SIGNING_KEY);

  return Response.json({
    tunnel_jwt: tunnelJwt,
    tunnel_refresh_token: tunnelRefreshToken,
    login,
  });
}

/**
 * POST /api/auth/tunnel/refresh — verify the tunnel refresh token, rotate it,
 * mint a fresh tunnel JWT.
 *
 * Body: { tunnel_refresh_token, login }. We need `login` because UserDO is
 * keyed by login (idFromName); the refresh token alone has no identity. The
 * daemon persists `login` alongside the refresh token at device-poll success.
 */
export async function handleTunnelRefresh(req: Request, env: AuthEnv): Promise<Response> {
  let body: { tunnel_refresh_token?: unknown; login?: unknown };
  try {
    body = (await req.json()) as { tunnel_refresh_token?: unknown; login?: unknown };
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (
    typeof body.tunnel_refresh_token !== 'string' ||
    body.tunnel_refresh_token.length === 0 ||
    typeof body.login !== 'string' ||
    body.login.length === 0
  ) {
    return new Response('missing tunnel_refresh_token or login', { status: 400 });
  }
  const oldToken = body.tunnel_refresh_token;
  const login = body.login;

  const userDoStub = env.USER_DO.get(env.USER_DO.idFromName(login));

  const oldHash = await sha256Hex(oldToken);
  const verifyRes = await userDoStub.fetch(
    new Request('https://do/verifyTunnelRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: oldHash }),
    }),
  );
  if (!verifyRes.ok) {
    return new Response('tunnel refresh verify failed', { status: 500 });
  }
  const verifyJson = (await verifyRes.json()) as { ok?: boolean };
  if (verifyJson.ok !== true) {
    return new Response('invalid tunnel refresh token', { status: 401 });
  }

  // Look up the canonical github_id.
  const getLoginRes = await userDoStub.fetch(new Request('https://do/getLogin'));
  if (getLoginRes.status === 404) {
    return new Response('user not found', { status: 401 });
  }
  if (!getLoginRes.ok) {
    return new Response('userDO getLogin failed', { status: 500 });
  }
  const rec = (await getLoginRes.json()) as { github_id: string; login: string };

  // Rotate: new opaque refresh + new hash. Writing the new hash overwrites
  // the old one, so the old token can no longer pass verifyTunnelRefreshTokenHash.
  const newToken = randomHex(32);
  const newHash = await sha256Hex(newToken);
  const setHashRes = await userDoStub.fetch(
    new Request('https://do/setTunnelRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: newHash }),
    }),
  );
  if (!setHashRes.ok) {
    return new Response('userDO setTunnelRefreshTokenHash failed', { status: 500 });
  }

  const iat = Math.floor(Date.now() / 1000);
  const claims: TunnelJwtClaims = {
    sub: rec.github_id,
    login: rec.login,
    iat,
    exp: iat + TUNNEL_JWT_TTL_SEC,
    kind: 'tunnel',
    jti: randomHex(16),
  };
  const tunnelJwt = await signJwt(claims, env.JWT_REFRESH_SIGNING_KEY);

  return Response.json({
    tunnel_jwt: tunnelJwt,
    tunnel_refresh_token: newToken,
  });
}

/**
 * Top-level dispatch for the device-flow + tunnel-refresh prefix. Returns
 * null when the path is not ours so the caller (index.ts) can fall through
 * to the web OAuth dispatcher.
 */
export async function dispatchDevice(req: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'POST' && path === '/api/auth/device/start') {
    return handleDeviceStart(req, env);
  }
  if (req.method === 'POST' && path === '/api/auth/device/poll') {
    return handleDevicePoll(req, env);
  }
  if (req.method === 'POST' && path === '/api/auth/tunnel/refresh') {
    return handleTunnelRefresh(req, env);
  }
  return null;
}
