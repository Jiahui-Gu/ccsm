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
import { Logger, shortSub } from '../logger';
import { decideAndLink, MultipleAccountsError } from './oauthLinker';

/** R-46 audit-P0 (Task #158): logger child bound to the request_id header
 *  the Worker entry stamped on. */
function loggerFor(req: Request): Logger {
  const requestId = req.headers.get('X-CCSM-Request-Id') ?? 'no-req-id';
  return new Logger().child(requestId);
}

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
  /** read:user scope returns this without a verified flag — see webOauth. */
  email?: string | null;
}

/**
 * POST /api/auth/device/start — proxy to GitHub's device-code endpoint and
 * pass the returned user_code / verification_uri back to the caller.
 */
export async function handleDeviceStart(req: Request, env: AuthEnv): Promise<Response> {
  void req;
  const log = loggerFor(req);
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
    log.error('device.start_fail', { reason: 'github_http_error', status: ghRes.status });
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
    log.error('device.start_fail', { reason: 'malformed_response' });
    return new Response('github device/code malformed', { status: 502 });
  }
  log.info('device.start_ok', { interval: json.interval, expires_in: json.expires_in });
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
  const log = loggerFor(req);
  let body: { device_code?: unknown };
  try {
    body = (await req.json()) as { device_code?: unknown };
  } catch {
    log.warn('device.poll', { result: 'fail', reason: 'bad_json' });
    return new Response('bad json', { status: 400 });
  }
  if (typeof body.device_code !== 'string' || body.device_code.length === 0) {
    log.warn('device.poll', { result: 'fail', reason: 'missing_device_code' });
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
    log.warn('device.poll', { result: 'fail', reason: 'github_http_error', status: tokenRes.status });
    return new Response('github device token poll failed', { status: 502 });
  }
  const tokenJson = (await tokenRes.json()) as GithubTokenPollResponse;

  // Pending / slow_down / expired / denied — translate.
  if (tokenJson.error) {
    switch (tokenJson.error) {
      case 'authorization_pending':
        log.debug('device.poll', { result: 'pending' });
        return Response.json({ status: 'pending', interval: tokenJson.interval });
      case 'slow_down':
        log.debug('device.poll', { result: 'slow_down', interval: tokenJson.interval });
        // Honor the new interval GitHub gave us.
        return Response.json({ status: 'slow_down', interval: tokenJson.interval });
      case 'expired_token':
        log.warn('device.poll', { result: 'expired' });
        return new Response(JSON.stringify({ status: 'expired' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        });
      case 'access_denied':
        log.warn('device.poll', { result: 'denied' });
        return new Response(JSON.stringify({ status: 'denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      default:
        log.error('device.poll', { result: 'error', gh_error: tokenJson.error });
        return new Response(
          JSON.stringify({ status: 'error', error: tokenJson.error }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        );
    }
  }

  if (typeof tokenJson.access_token !== 'string' || tokenJson.access_token.length === 0) {
    log.error('device.poll', { result: 'fail', reason: 'malformed_token_response' });
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
  const email = typeof userJson.email === 'string' ? userJson.email : '';

  // R-51a (Task #167): shared linker decides login_existing /
  // create_no_email / link_to_existing / create_new and writes user blob +
  // identity + (verified) email index through. Device flow + web callback
  // both arrive here.
  let linkResult;
  try {
    linkResult = await decideAndLink(env, {
      provider: 'github',
      provider_sub: githubId,
      login,
      email,
      email_verified: false,
    });
  } catch (err) {
    if (err instanceof MultipleAccountsError) {
      log.warn('device.poll', { result: 'fail', reason: 'multiple_accounts' });
      return new Response(JSON.stringify({ status: 'multiple-accounts' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
    log.error('device.poll', { result: 'fail', reason: 'linker_failed', err: String(err) });
    return new Response('linker failed', { status: 500 });
  }
  const userId = linkResult.user_id;

  // Mint tunnel refresh token + persist hash on the user blob role.
  const userBlobStub = env.USER_DO.get(env.USER_DO.idFromName(`user:${userId}`));
  const tunnelRefreshToken = randomHex(32);
  const tunnelRefreshHash = await sha256Hex(tunnelRefreshToken);
  const setHashRes = await userBlobStub.fetch(
    new Request('https://do/setTunnelRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: tunnelRefreshHash }),
    }),
  );
  if (!setHashRes.ok) {
    return new Response('userDO setTunnelRefreshTokenHash failed', { status: 500 });
  }

  // Mint tunnel JWT — claims.sub = uuid (was github_id pre-R-51).
  const iat = Math.floor(Date.now() / 1000);
  const claims: TunnelJwtClaims = {
    sub: userId,
    login,
    iat,
    exp: iat + TUNNEL_JWT_TTL_SEC,
    kind: 'tunnel',
    jti: randomHex(16),
  };
  const tunnelJwt = await signJwt(claims, env.JWT_REFRESH_SIGNING_KEY);

  log.info('device.poll', {
    result: 'ok',
    decision: linkResult.decision,
    login,
    sub_prefix: shortSub(userId),
  });

  // R-51a: response carries `user_id` so daemon (R-51b) persists the new
  // PK alongside its existing `login` field for display continuity.
  return Response.json({
    tunnel_jwt: tunnelJwt,
    tunnel_refresh_token: tunnelRefreshToken,
    user_id: userId,
    login,
  });
}

/**
 * POST /api/auth/tunnel/refresh — verify the tunnel refresh token, rotate it,
 * mint a fresh tunnel JWT.
 *
 * Body: { tunnel_refresh_token, user_id }. R-51a (Task #167) replaced the
 * previous `login` field with `user_id` (the new uuid PK). The daemon
 * (R-51b) persists `user_id` alongside the refresh token at device-poll
 * success and replays it here so the worker can locate the user blob.
 */
export async function handleTunnelRefresh(req: Request, env: AuthEnv): Promise<Response> {
  const log = loggerFor(req);
  let body: { tunnel_refresh_token?: unknown; user_id?: unknown };
  try {
    body = (await req.json()) as { tunnel_refresh_token?: unknown; user_id?: unknown };
  } catch {
    log.warn('tunnel.refresh_fail', { reason: 'bad_json' });
    return new Response('bad json', { status: 400 });
  }
  if (
    typeof body.tunnel_refresh_token !== 'string' ||
    body.tunnel_refresh_token.length === 0 ||
    typeof body.user_id !== 'string' ||
    body.user_id.length === 0
  ) {
    log.warn('tunnel.refresh_fail', { reason: 'missing_fields' });
    return new Response('missing tunnel_refresh_token or user_id', { status: 400 });
  }
  const oldToken = body.tunnel_refresh_token;
  const userId = body.user_id;

  const userDoStub = env.USER_DO.get(env.USER_DO.idFromName(`user:${userId}`));

  const oldHash = await sha256Hex(oldToken);
  const verifyRes = await userDoStub.fetch(
    new Request('https://do/verifyTunnelRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: oldHash }),
    }),
  );
  if (!verifyRes.ok) {
    log.error('tunnel.refresh_fail', {
      reason: 'userdo_verify_http_error',
      status: verifyRes.status,
      uid_prefix: shortSub(userId),
    });
    return new Response('tunnel refresh verify failed', { status: 500 });
  }
  const verifyJson = (await verifyRes.json()) as { ok?: boolean };
  if (verifyJson.ok !== true) {
    log.warn('tunnel.refresh_fail', {
      reason: 'invalid_token',
      uid_prefix: shortSub(userId),
    });
    return new Response('invalid tunnel refresh token', { status: 401 });
  }

  // Look up the canonical user blob.
  const getBlobRes = await userDoStub.fetch(new Request('https://do/getUserBlob'));
  if (getBlobRes.status === 404) {
    log.warn('tunnel.refresh_fail', { reason: 'user_not_found', uid_prefix: shortSub(userId) });
    return new Response('user not found', { status: 401 });
  }
  if (!getBlobRes.ok) {
    log.error('tunnel.refresh_fail', {
      reason: 'userdo_getuserblob_failed',
      status: getBlobRes.status,
      uid_prefix: shortSub(userId),
    });
    return new Response('userDO getUserBlob failed', { status: 500 });
  }
  const blob = (await getBlobRes.json()) as { user_id: string; primary_login: string };

  // Rotate.
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
    log.error('tunnel.refresh_fail', {
      reason: 'userdo_setrefreshhash_failed',
      status: setHashRes.status,
      uid_prefix: shortSub(userId),
    });
    return new Response('userDO setTunnelRefreshTokenHash failed', { status: 500 });
  }

  const iat = Math.floor(Date.now() / 1000);
  const claims: TunnelJwtClaims = {
    sub: blob.user_id,
    login: blob.primary_login,
    iat,
    exp: iat + TUNNEL_JWT_TTL_SEC,
    kind: 'tunnel',
    jti: randomHex(16),
  };
  const tunnelJwt = await signJwt(claims, env.JWT_REFRESH_SIGNING_KEY);

  log.info('tunnel.refresh_ok', {
    login: blob.primary_login,
    sub_prefix: shortSub(blob.user_id),
    jti: claims.jti,
  });

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
