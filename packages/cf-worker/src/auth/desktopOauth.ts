/**
 * R-51b (Task #168): cf-worker desktop OAuth (PKCE) flow handlers.
 *
 * Tauri shells use this path instead of device flow when the OS supports a
 * `ccsm://` deep link (R-51c will demote device flow to a fallback UI). The
 * round-trip:
 *
 *   POST /api/auth/desktop/start
 *     — mint random `state` + PKCE `code_verifier` + `code_challenge` (S256),
 *       persist `{code_verifier, created_at}` under a fresh PKCE-state UserDO
 *       role (`pkce:state:<state>`), return `{auth_url}` containing the
 *       GitHub authorize URL with state + code_challenge + redirect_uri.
 *
 *   GET  /oauth/desktop/cb?code=&state=
 *     — verify state (UserDO hit + age <5min), exchange `code` + the stored
 *       `code_verifier` against GitHub /access_token (PKCE: client side does
 *       NOT need a client_secret — but GitHub OAuth Apps still demand it so
 *       we send both, GitHub still validates the verifier), fetch user info,
 *       run shared linker (R-51a), mint tunnel JWT + refresh token, render an
 *       HTML page that immediately redirects to
 *       `ccsm://oauth?token=<jwt>&refresh=<refresh>&state=<state>` with a
 *       fallback button + copy.
 *
 * Why PKCE in addition to client_secret: although the GitHub Web flow does
 * not strictly require PKCE, it accepts the PKCE verifier and is the recipe
 * that lets us be CSRF-tight even with the public redirect_uri scheme. The
 * stored `code_verifier` ties the started authorize to the callback.
 *
 * State row TTL: 5 minutes. After expiry the entry is treated as missing and
 * the callback returns 400 even if the row is still on disk (UserDO storage
 * does not auto-expire).
 *
 * Redirect URI: `<auth_base>/oauth/desktop/cb`. v0.4 uses
 * `https://cc-sm.pages.dev/oauth/desktop/cb` in production, matching the
 * GitHub OAuth App's prefix-allowed callback. The `auth_base` is derived
 * from the request URL so wrangler dev / cloud tunnel both resolve the same
 * way without baking in a hostname.
 *
 * State storage role (added to UserDO in this PR):
 *   - idFromName('pkce:state:<state>') → { code_verifier, created_at }
 *
 * Logger event prefix: `oauth.desktop.*` (start_ok / start_fail /
 * callback_ok / callback_fail). Token-bearing fields are dropped by the
 * logger redactor (R-46) so the rendered URL never appears in logs.
 *
 * NOT in scope for this PR (R-51c):
 *   - Tauri renderer SPA UI changes
 *   - cf-worker deploy (left to R-51c end-to-end verification)
 */
import type { AuthEnv } from './bindings';
import { signJwt, type TunnelJwtClaims } from './jwt';
import { Logger, shortSub } from '../logger';
import { decideAndLink, MultipleAccountsError } from './oauthLinker';

const GH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GH_USER_URL = 'https://api.github.com/user';

const TUNNEL_JWT_TTL_SEC = 60 * 60 * 24; // 24h, mirrors deviceFlow
const PKCE_STATE_TTL_SEC = 5 * 60; // 5 minutes — short by design.
const DESKTOP_CALLBACK_PATH = '/oauth/desktop/cb';

function loggerFor(req: Request): Logger {
  const requestId = req.headers.get('X-CCSM-Request-Id') ?? 'no-req-id';
  return new Logger().child(requestId);
}

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
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return bytesToHex(new Uint8Array(digest));
}

/** RFC 7636 §4.2 base64url(SHA256(verifier)) — no padding. */
async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Derive the auth base (origin) from the inbound request URL so we don't
 *  hard-code a host name. wrangler dev sees `http://127.0.0.1:8787`,
 *  production sees `https://cc-sm.pages.dev`. */
function authOrigin(req: Request): string {
  return new URL(req.url).origin;
}

interface PkceStateRow {
  code_verifier: string;
  created_at: number;
}

async function putPkceState(
  env: AuthEnv,
  state: string,
  row: PkceStateRow,
): Promise<void> {
  const stub = env.USER_DO.get(env.USER_DO.idFromName(`pkce:state:${state}`));
  const res = await stub.fetch(
    new Request('https://do/setPkceState', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
    }),
  );
  if (!res.ok) throw new Error(`setPkceState http ${res.status}`);
}

async function takePkceState(
  env: AuthEnv,
  state: string,
): Promise<PkceStateRow | null> {
  const stub = env.USER_DO.get(env.USER_DO.idFromName(`pkce:state:${state}`));
  const res = await stub.fetch(new Request('https://do/getPkceState'));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getPkceState http ${res.status}`);
  const row = (await res.json()) as PkceStateRow;
  // One-shot use: clear immediately so a replayed callback cannot reuse the
  // verifier even if the GitHub /access_token call below fails.
  await stub.fetch(new Request('https://do/clearPkceState', { method: 'POST' }));
  return row;
}

/**
 * POST /api/auth/desktop/start — Tauri shell calls this before opening the
 * system browser. We mint state + verifier + challenge, persist (state →
 * verifier) for the callback, and return the GitHub authorize URL the shell
 * should open via Shell.open.
 */
export async function handleDesktopStart(
  req: Request,
  env: AuthEnv,
): Promise<Response> {
  const log = loggerFor(req);
  // 32 bytes -> 64 hex chars; well within the RFC 7636 §4.1 verifier range
  // (43..128) and consistent with the rest of the auth subsystem's secret
  // sizing.
  const state = randomHex(32);
  const codeVerifier = randomHex(32);
  const codeChallenge = await pkceChallengeS256(codeVerifier);

  try {
    await putPkceState(env, state, {
      code_verifier: codeVerifier,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    log.error('oauth.desktop.start_fail', {
      reason: 'userdo_setpkce_failed',
      err: String(err),
    });
    return new Response('userDO setPkceState failed', { status: 500 });
  }

  const redirectUri = `${authOrigin(req)}${DESKTOP_CALLBACK_PATH}`;
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    state,
    scope: 'read:user',
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const authUrl = `${GH_AUTHORIZE_URL}?${params.toString()}`;

  log.info('oauth.desktop.start_ok', {
    state_prefix: shortSub(state),
  });

  return Response.json({ auth_url: authUrl });
}

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
  email?: string | null;
}

/** Render the deep-link bounce page. Uses location.replace so the user does
 *  not see an intermediate URL in history; provides a manual button + copy
 *  in case the OS prompt was dismissed. The token bearing URL never lands
 *  in `Location:` (which CF logs); it lives in the inline script + button. */
function renderBouncePage(deepLink: string): Response {
  // We deliberately interpolate the token-bearing URL into the page body.
  // It is one-shot (PKCE state has been cleared by takePkceState above) and
  // never logged: cf-worker emits no log line containing the deep link.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Signing in to ccsm-tauri</title>
  <style>
    body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
           max-width: 480px; margin: 6rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    p { margin: 0 0 1rem; }
    a.btn { display: inline-block; padding: 0.6rem 1rem; background: #1f2937;
            color: #fff; text-decoration: none; border-radius: 6px;
            font-weight: 600; }
    a.btn:hover { background: #111827; }
    .muted { color: #6b7280; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Sign-in successful</h1>
  <p>Returning to the ccsm desktop app&hellip;</p>
  <p><a id="open" class="btn" href="${escapeHtml(deepLink)}">Open ccsm desktop</a></p>
  <p class="muted">If nothing happens, click the button above. You can close this tab afterwards.</p>
  <script>
    // Immediate handoff. location.replace avoids a back-button ghost.
    location.replace(${JSON.stringify(deepLink)});
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * GET /oauth/desktop/cb?code=&state= — desktop OAuth callback.
 *
 * On success renders an HTML page that location.replace()s into
 * `ccsm://oauth?token=<jwt>&refresh=<refresh_token>&state=<state>` so the
 * Tauri shell's deep-link listener picks it up. The Tauri side
 * (`auth.rs::handle_desktop_callback`) verifies `state` against an in-memory
 * map populated when `start_pkce_oauth` ran, then writes the creds file.
 */
export async function handleDesktopCallback(
  req: Request,
  env: AuthEnv,
): Promise<Response> {
  const log = loggerFor(req);
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    log.warn('oauth.desktop.callback_fail', {
      reason: 'missing_code_or_state',
    });
    return new Response('missing code or state', { status: 400 });
  }

  let row: PkceStateRow | null;
  try {
    row = await takePkceState(env, state);
  } catch (err) {
    log.error('oauth.desktop.callback_fail', {
      reason: 'userdo_takepkce_failed',
      err: String(err),
    });
    return new Response('userDO takePkceState failed', { status: 500 });
  }
  if (row === null) {
    log.warn('oauth.desktop.callback_fail', {
      reason: 'unknown_state',
      state_prefix: shortSub(state),
    });
    return new Response('unknown or used state', { status: 400 });
  }
  const ageSec = Math.floor(Date.now() / 1000) - row.created_at;
  if (ageSec > PKCE_STATE_TTL_SEC) {
    log.warn('oauth.desktop.callback_fail', {
      reason: 'state_expired',
      age_sec: ageSec,
    });
    return new Response('state expired', { status: 400 });
  }

  const redirectUri = `${authOrigin(req)}${DESKTOP_CALLBACK_PATH}`;

  // Exchange code → access_token, including code_verifier (PKCE). GitHub
  // OAuth Apps require client_secret too; PKCE is layered on top, providing
  // proof that the callback caller is the same shell that opened the
  // authorize URL (verifier never leaves cf-worker storage).
  const tokenRes = await fetch(GH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: row.code_verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    log.warn('oauth.desktop.callback_fail', {
      reason: 'github_token_exchange_http_error',
      status: tokenRes.status,
    });
    return new Response('github token exchange failed', { status: 502 });
  }
  const tokenJson = (await tokenRes.json()) as GithubTokenResponse;
  if (!tokenJson.access_token) {
    // PKCE verifier mismatch shows up here as `error: bad_verification_code`
    // (or invalid_grant) — GitHub returns 200 with an error payload.
    log.warn('oauth.desktop.callback_fail', {
      reason: 'github_token_exchange_rejected',
      gh_error: tokenJson.error ?? 'unknown',
    });
    return new Response(
      'github token exchange rejected: ' + (tokenJson.error ?? 'unknown'),
      { status: 400 },
    );
  }
  const accessToken = tokenJson.access_token;

  const userRes = await fetch(GH_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ccsm-cf-worker',
    },
  });
  if (!userRes.ok) {
    log.warn('oauth.desktop.callback_fail', {
      reason: 'github_user_http_error',
      status: userRes.status,
    });
    return new Response('github user fetch failed', { status: 502 });
  }
  const userJson = (await userRes.json()) as GithubUserResponse;
  if (typeof userJson.id !== 'number' || typeof userJson.login !== 'string') {
    log.warn('oauth.desktop.callback_fail', {
      reason: 'github_user_malformed',
    });
    return new Response('github user response malformed', { status: 502 });
  }
  const githubId = String(userJson.id);
  const login = userJson.login;
  const email = typeof userJson.email === 'string' ? userJson.email : '';

  let linkResult;
  try {
    linkResult = await decideAndLink(env, {
      provider: 'github',
      provider_sub: githubId,
      login,
      email,
      // read:user scope: same caveat as web/device flows — no verified flag.
      email_verified: false,
    });
  } catch (err) {
    if (err instanceof MultipleAccountsError) {
      log.warn('oauth.desktop.callback_fail', {
        reason: 'multiple_accounts',
        email_index_user_id: err.emailIndexUserId,
        identity_user_id: err.identityUserId,
      });
      return new Response('multiple-accounts', { status: 409 });
    }
    log.error('oauth.desktop.callback_fail', {
      reason: 'linker_failed',
      err: String(err),
    });
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
    log.error('oauth.desktop.callback_fail', {
      reason: 'userdo_settunnelrefreshhash_failed',
      status: setHashRes.status,
    });
    return new Response('userDO setTunnelRefreshTokenHash failed', {
      status: 500,
    });
  }

  // Mint tunnel JWT — sub = uuid (R-51a).
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

  log.info('oauth.desktop.callback_ok', {
    decision: linkResult.decision,
    login,
    sub_prefix: shortSub(userId),
    jti: claims.jti,
  });

  // Compose the deep link. `state` is echoed back so the Tauri-side listener
  // can verify it against the in-memory state minted at start_pkce_oauth
  // and reject replays / cross-instance bounces.
  const deepLink =
    'ccsm://oauth?' +
    new URLSearchParams({
      token: tunnelJwt,
      refresh: tunnelRefreshToken,
      state,
    }).toString();

  return renderBouncePage(deepLink);
}

/**
 * Top-level dispatch. Returns null when the path is not ours.
 *
 * Two prefixes:
 *   POST /api/auth/desktop/start
 *   GET  /oauth/desktop/cb
 */
export async function dispatchDesktop(
  req: Request,
  env: AuthEnv,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'POST' && path === '/api/auth/desktop/start') {
    return handleDesktopStart(req, env);
  }
  if (req.method === 'GET' && path === DESKTOP_CALLBACK_PATH) {
    return handleDesktopCallback(req, env);
  }
  return null;
}
