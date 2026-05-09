/**
 * S4-T3 (Task #140): cf-worker web OAuth flow handlers.
 *
 * Implements the four browser-side endpoints that turn a GitHub OAuth App
 * round-trip into a short-lived web JWT + a long-lived rotating refresh token:
 *
 *   GET  /api/auth/github/login    → 302 to github.com/login/oauth/authorize
 *                                    sets `csrf` cookie (HttpOnly, Path scoped
 *                                    to the callback) so the callback can
 *                                    cross-check `state`.
 *   GET  /api/auth/github/callback → exchange `code` → access_token, fetch
 *                                    GitHub user, persist into UserDO, mint
 *                                    web JWT (kind='web', 1h) + refresh token
 *                                    (32-byte opaque hex). Refresh hash stored
 *                                    in UserDO. 302 to `/?session=ok` with
 *                                    refresh in HttpOnly cookie + web_jwt in
 *                                    URL fragment (#jwt=...) for SignInGate to
 *                                    pick up once.
 *   POST /api/auth/refresh         → re-mint web JWT from refresh cookie.
 *                                    Returns `{ web_jwt }` JSON.
 *   POST /api/auth/logout          → clear refresh cookie + UserDO.revoke().
 *                                    Returns 204.
 *
 * Refresh-token rotation strategy: the random opaque token is sent to the
 * browser only once (in HttpOnly cookie); we only persist its SHA-256 hex
 * hash in UserDO. Rotation on each refresh would be ideal but is out-of-scope
 * for T3 (T4 device flow can fold that in alongside the daemon path).
 *
 * CSRF: state is 32-byte hex generated with crypto.getRandomValues. Cookie is
 * HttpOnly, SameSite=Lax, Secure, Path=/api/auth/github/callback so it is
 * only attached to the callback request and never to other API paths.
 *
 * NOT in scope (T5): /ws, /tunnel, /api/sessions, /token continue to flow
 * through TunnelDO. Only the /api/auth/* prefix routes here.
 */
import type { AuthEnv } from './bindings';
import { signJwt, verifyJwt, type WebJwtClaims } from './jwt';
import { Logger, shortSub } from '../logger';

/** R-46 audit-P0 (Task #158, F-T-2): rebuild a child logger from the
 *  request_id header that the Worker entry stamped on. */
function loggerFor(req: Request): Logger {
  const requestId = req.headers.get('X-CCSM-Request-Id') ?? 'no-req-id';
  return new Logger().child(requestId);
}

const GH_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GH_USER_URL = 'https://api.github.com/user';

const WEB_JWT_TTL_SEC = 60 * 60; // 1h
/**
 * Audit F-S-4 (Task #152): ws subprotocol can't ride a cookie, so we mint
 * a short-lived JWT (60s) the SPA fetches right before opening the
 * WebSocket. Browser exposure window is one upgrade.
 */
const WS_TICKET_TTL_SEC = 60;
const CSRF_COOKIE = 'csrf';
const REFRESH_COOKIE = 'refresh';
/** Audit F-S-4: HttpOnly session cookie carrying the web JWT, scoped to /api. */
const WEB_JWT_COOKIE = 'web_jwt';
const CALLBACK_PATH = '/api/auth/github/callback';
const REFRESH_PATH = '/api/auth/refresh';
const WEB_JWT_COOKIE_PATH = '/api';

/** Hex-encode a Uint8Array. */
function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

/** Cryptographically random hex string of `byteLen` bytes. */
function randomHex(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** SHA-256 of the input string, returned as hex. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** Parse a `Cookie:` header into a Map. Returns empty map if absent / blank. */
function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k.length > 0) out.set(k, v);
  }
  return out;
}

/** Build a Set-Cookie header value. */
function buildCookie(
  name: string,
  value: string,
  opts: { path: string; maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Lax' | 'Strict' | 'None' },
): string {
  let s = `${name}=${value}; Path=${opts.path}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly !== false) s += '; HttpOnly';
  if (opts.secure !== false) s += '; Secure';
  s += `; SameSite=${opts.sameSite ?? 'Lax'}`;
  return s;
}

/** Build a Set-Cookie that clears `name` on `path`. */
function clearCookie(name: string, path: string): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * GET /api/auth/github/login — 302 redirect into GitHub authorize, with a
 * fresh csrf state baked into the URL and into a path-scoped cookie.
 */
export function handleGithubLogin(req: Request, env: AuthEnv): Response {
  void req;
  const log = loggerFor(req);
  const state = randomHex(32);
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    state,
    scope: 'read:user',
  });
  const headers = new Headers({
    Location: `${GH_AUTHORIZE_URL}?${params.toString()}`,
    'Set-Cookie': buildCookie(CSRF_COOKIE, state, {
      path: CALLBACK_PATH,
      maxAge: 600, // 10 min — the user has to bounce through GitHub and back
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }),
  });
  log.info('oauth.login_redirect', {});
  return new Response(null, { status: 302, headers });
}

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
}

/**
 * GET /api/auth/github/callback — verify state, exchange code, persist user,
 * mint web JWT + refresh token, redirect home with both surfaced.
 */
export async function handleGithubCallback(
  req: Request,
  env: AuthEnv,
): Promise<Response> {
  const log = loggerFor(req);
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    log.warn('oauth.callback_fail', { reason: 'missing_code_or_state' });
    return new Response('missing code or state', { status: 400 });
  }

  const cookies = parseCookies(req.headers.get('Cookie'));
  const cookieState = cookies.get(CSRF_COOKIE);
  if (!cookieState || cookieState !== state) {
    log.warn('oauth.callback_fail', { reason: 'csrf_mismatch' });
    return new Response('csrf state mismatch', { status: 400 });
  }

  // Exchange code → access_token. GitHub honours `Accept: application/json`.
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
    }).toString(),
  });
  if (!tokenRes.ok) {
    log.warn('oauth.callback_fail', {
      reason: 'github_token_exchange_http_error',
      status: tokenRes.status,
    });
    return new Response('github token exchange failed', { status: 502 });
  }
  const tokenJson = (await tokenRes.json()) as GithubTokenResponse;
  if (!tokenJson.access_token) {
    log.warn('oauth.callback_fail', {
      reason: 'github_token_exchange_rejected',
      gh_error: tokenJson.error ?? 'unknown',
    });
    return new Response(
      'github token exchange rejected: ' + (tokenJson.error ?? 'unknown'),
      { status: 502 },
    );
  }
  const accessToken = tokenJson.access_token;

  // Fetch the user identity.
  const userRes = await fetch(GH_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      // GitHub REST recommends a UA; workerd sends one but be explicit.
      'User-Agent': 'ccsm-cf-worker',
    },
  });
  if (!userRes.ok) {
    log.warn('oauth.callback_fail', {
      reason: 'github_user_http_error',
      status: userRes.status,
    });
    return new Response('github user fetch failed', { status: 502 });
  }
  const userJson = (await userRes.json()) as GithubUserResponse;
  if (typeof userJson.id !== 'number' || typeof userJson.login !== 'string') {
    log.warn('oauth.callback_fail', { reason: 'github_user_malformed' });
    return new Response('github user response malformed', { status: 502 });
  }
  const githubId = String(userJson.id);
  const login = userJson.login;

  // Persist into UserDO (idFromName(login)).
  const userDoId = env.USER_DO.idFromName(login);
  const userDoStub = env.USER_DO.get(userDoId);

  const setLoginRes = await userDoStub.fetch(
    new Request('https://do/setLogin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ github_id: githubId, login }),
    }),
  );
  if (!setLoginRes.ok) {
    log.error('oauth.callback_fail', {
      reason: 'userdo_setlogin_failed',
      status: setLoginRes.status,
    });
    return new Response('userDO setLogin failed', { status: 500 });
  }

  // Mint the refresh token (opaque hex) + persist its SHA-256 hash in UserDO.
  const refreshToken = randomHex(32);
  const refreshHash = await sha256Hex(refreshToken);
  const setHashRes = await userDoStub.fetch(
    new Request('https://do/setRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: refreshHash }),
    }),
  );
  if (!setHashRes.ok) {
    log.error('oauth.callback_fail', {
      reason: 'userdo_setrefreshhash_failed',
      status: setHashRes.status,
    });
    return new Response('userDO setRefreshTokenHash failed', { status: 500 });
  }

  // Mint the web JWT.
  const iat = Math.floor(Date.now() / 1000);
  const claims: WebJwtClaims = {
    sub: githubId,
    login,
    iat,
    exp: iat + WEB_JWT_TTL_SEC,
    kind: 'web',
  };
  const webJwt = await signJwt(claims, env.JWT_SIGNING_KEY);

  log.info('oauth.callback_ok', {
    login,
    sub_prefix: shortSub(githubId),
  });

  // Compose the redirect: the web JWT now rides an HttpOnly cookie scoped to
  // `/api` (audit F-S-4, Task #152). The SPA learns it's signed-in by
  // `GET /api/auth/me`; the URL fragment used to carry the JWT (T3) is gone.
  const headers = new Headers();
  headers.append('Location', `/?session=ok`);
  // Clear the csrf cookie now that we've consumed it.
  headers.append('Set-Cookie', clearCookie(CSRF_COOKIE, CALLBACK_PATH));
  // HttpOnly + Secure + SameSite=Strict so an XSS payload cannot exfiltrate
  // the JWT and a cross-site link cannot ride the session.
  headers.append(
    'Set-Cookie',
    buildCookie(WEB_JWT_COOKIE, webJwt, {
      path: WEB_JWT_COOKIE_PATH,
      maxAge: WEB_JWT_TTL_SEC,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    }),
  );
  // Persist the refresh token in an HttpOnly cookie scoped to the refresh path.
  headers.append(
    'Set-Cookie',
    buildCookie(REFRESH_COOKIE, refreshToken, {
      path: REFRESH_PATH,
      maxAge: 60 * 60 * 24 * 30, // 30 days
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }),
  );
  // `login` hint cookie — not a secret, only the UserDO key. Scoped to
  // /api/auth so it accompanies refresh + logout requests.
  headers.append(
    'Set-Cookie',
    buildCookie('login', login, {
      path: '/api/auth',
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }),
  );
  return new Response(null, { status: 302, headers });
}

/**
 * POST /api/auth/refresh — verify the refresh cookie against the UserDO hash,
 * **rotate** it (write a fresh hash + send a fresh cookie), and re-mint a web
 * JWT.
 *
 * Audit F-S-5 (Task #152): web refresh now rotates on every call (parity
 * with deviceFlow tunnel-refresh). Without rotation a leaked refresh
 * token grants attacker indefinite access until manual revoke. The new
 * opaque token is sent back as the same HttpOnly cookie; the old hash is
 * overwritten so subsequent presentations of the old token 401.
 *
 * The browser has no other way to identify the user (web JWT may already be
 * gone), so we recover the login by stuffing the SHA-256 lookup into a
 * UserDO instance keyed by login... except we don't know the login yet. To
 * keep T3 simple, the refresh cookie is paired with a small hint cookie that
 * carries `login` (HttpOnly is fine, this isn't a secret). We trust the hint
 * and validate the hash before re-issuing anything.
 */
export async function handleRefresh(
  req: Request,
  env: AuthEnv,
): Promise<Response> {
  const log = loggerFor(req);
  const cookies = parseCookies(req.headers.get('Cookie'));
  const refreshToken = cookies.get(REFRESH_COOKIE);
  const loginHint = cookies.get('login');
  if (!refreshToken || !loginHint) {
    log.warn('auth.refresh_fail', { reason: 'missing_cookie' });
    return new Response('missing refresh cookie', { status: 401 });
  }
  const userDoId = env.USER_DO.idFromName(loginHint);
  const userDoStub = env.USER_DO.get(userDoId);

  const refreshHash = await sha256Hex(refreshToken);
  const verifyRes = await userDoStub.fetch(
    new Request('https://do/verifyRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: refreshHash }),
    }),
  );
  if (!verifyRes.ok) {
    log.error('auth.refresh_fail', { reason: 'userdo_verify_http_error', status: verifyRes.status });
    return new Response('refresh verify failed', { status: 500 });
  }
  const verifyJson = (await verifyRes.json()) as { ok?: boolean };
  if (verifyJson.ok !== true) {
    log.warn('auth.refresh_fail', { reason: 'invalid_refresh_token', login: loginHint });
    return new Response('invalid refresh token', { status: 401 });
  }

  // Look up the persisted login record so we mint claims with the canonical
  // (server-side) github_id, not just the cookie hint.
  const getLoginRes = await userDoStub.fetch(new Request('https://do/getLogin'));
  if (getLoginRes.status === 404) {
    log.warn('auth.refresh_fail', { reason: 'user_not_found', login: loginHint });
    return new Response('user not found', { status: 401 });
  }
  if (!getLoginRes.ok) {
    log.error('auth.refresh_fail', { reason: 'userdo_getlogin_failed', status: getLoginRes.status });
    return new Response('userDO getLogin failed', { status: 500 });
  }
  const rec = (await getLoginRes.json()) as { github_id: string; login: string };

  // Audit F-S-5: rotate the refresh token. Mint a new opaque hex + write
  // its hash into UserDO (overwrites the previous slot). Old token's hash
  // can no longer pass verifyRefreshTokenHash on a subsequent call.
  const newRefreshToken = randomHex(32);
  const newRefreshHash = await sha256Hex(newRefreshToken);
  const setHashRes = await userDoStub.fetch(
    new Request('https://do/setRefreshTokenHash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: newRefreshHash }),
    }),
  );
  if (!setHashRes.ok) {
    log.error('auth.refresh_fail', { reason: 'userdo_setrefreshhash_failed', status: setHashRes.status });
    return new Response('userDO setRefreshTokenHash failed', { status: 500 });
  }

  const iat = Math.floor(Date.now() / 1000);
  const claims: WebJwtClaims = {
    sub: rec.github_id,
    login: rec.login,
    iat,
    exp: iat + WEB_JWT_TTL_SEC,
    kind: 'web',
  };
  const webJwt = await signJwt(claims, env.JWT_SIGNING_KEY);
  log.info('auth.refresh_ok', { login: rec.login, sub_prefix: shortSub(rec.github_id) });
  const headers = new Headers({ 'content-type': 'application/json' });
  // Audit F-S-4: also re-set the web_jwt HttpOnly cookie so cookie-based
  // SPAs pick the new JWT up automatically without storing it in JS-reachable
  // state. body still echoes web_jwt for the legacy fragment-era callers.
  headers.append(
    'Set-Cookie',
    buildCookie(WEB_JWT_COOKIE, webJwt, {
      path: WEB_JWT_COOKIE_PATH,
      maxAge: WEB_JWT_TTL_SEC,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    }),
  );
  headers.append(
    'Set-Cookie',
    buildCookie(REFRESH_COOKIE, newRefreshToken, {
      path: REFRESH_PATH,
      maxAge: 60 * 60 * 24 * 30, // 30 days, mirroring callback
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }),
  );
  return new Response(JSON.stringify({ web_jwt: webJwt, login: rec.login }), {
    status: 200,
    headers,
  });
}

/**
 * POST /api/auth/logout — clear the refresh cookie + revoke UserDO state.
 */
export async function handleLogout(
  req: Request,
  env: AuthEnv,
): Promise<Response> {
  const log = loggerFor(req);
  const cookies = parseCookies(req.headers.get('Cookie'));
  const loginHint = cookies.get('login');
  // Best-effort revoke: if we don't have a hint, we still clear the cookie.
  if (loginHint) {
    const userDoId = env.USER_DO.idFromName(loginHint);
    const userDoStub = env.USER_DO.get(userDoId);
    await userDoStub.fetch(new Request('https://do/revoke', { method: 'POST' }));
  }
  log.info('auth.logout', { login: loginHint });
  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie(REFRESH_COOKIE, REFRESH_PATH));
  headers.append('Set-Cookie', clearCookie('login', '/api/auth'));
  // Audit F-S-4: also nuke the web_jwt session cookie.
  headers.append('Set-Cookie', clearCookie(WEB_JWT_COOKIE, WEB_JWT_COOKIE_PATH));
  return new Response(null, { status: 204, headers });
}

/**
 * GET /api/auth/me — audit F-S-4 (Task #152).
 *
 * Reads the HttpOnly `web_jwt` cookie, verifies it, returns
 * `{ login, github_id }`. The SPA mounts and calls this to learn whether
 * the user is signed-in (replacing the old fragment-decode + sessionStorage
 * read). 401 means "not signed-in" — caller renders SignInScreen.
 *
 * No CSRF token is required because:
 *   (a) it's a GET / safe method,
 *   (b) the cookie is SameSite=Strict so cross-site requests don't carry
 *       the credential.
 */
export async function handleMe(req: Request, env: AuthEnv): Promise<Response> {
  const cookies = parseCookies(req.headers.get('Cookie'));
  const jwt = cookies.get(WEB_JWT_COOKIE);
  if (!jwt) return new Response('unauthorized', { status: 401 });
  const claims = await verifyJwt<WebJwtClaims>(jwt, env.JWT_SIGNING_KEY);
  if (claims === null || claims.kind !== 'web') {
    return new Response('unauthorized', { status: 401 });
  }
  return Response.json({ login: claims.login, github_id: claims.sub });
}

/**
 * POST /api/auth/ws-ticket — audit F-S-4 (Task #152).
 *
 * Browsers cannot ride a cookie on `new WebSocket(url, protocols)`; the
 * subprotocol is the only writable header. The SPA fetches a 60-second JWT
 * (`kind='web'`, freshly minted from the same signing key) and presents it
 * as `Sec-WebSocket-Protocol: ccsm.<ticket>`. middleware.extractWebJwt
 * verifies the ticket on the upgrade like any other web JWT.
 *
 * Why a separate ticket: the long-lived (1h) `web_jwt` cookie never leaves
 * server-managed storage. The short-lived ticket DOES briefly land in JS
 * (we can't avoid it — `WebSocket` constructor takes the protocol from
 * an argument), so we cap its TTL to 60s to bound the window of a leaked
 * value.
 *
 * CSRF is naturally bound by SameSite=Strict on the source cookie + the
 * fact that an attacker page cannot make a same-origin POST that reads
 * the response body (CORS).
 */
export async function handleWsTicket(req: Request, env: AuthEnv): Promise<Response> {
  const cookies = parseCookies(req.headers.get('Cookie'));
  const jwt = cookies.get(WEB_JWT_COOKIE);
  if (!jwt) return new Response('unauthorized', { status: 401 });
  const claims = await verifyJwt<WebJwtClaims>(jwt, env.JWT_SIGNING_KEY);
  if (claims === null || claims.kind !== 'web') {
    return new Response('unauthorized', { status: 401 });
  }
  const iat = Math.floor(Date.now() / 1000);
  const ticketClaims: WebJwtClaims = {
    sub: claims.sub,
    login: claims.login,
    iat,
    exp: iat + WS_TICKET_TTL_SEC,
    kind: 'web',
  };
  const ticket = await signJwt(ticketClaims, env.JWT_SIGNING_KEY);
  return Response.json({ ws_ticket: ticket, expires_in: WS_TICKET_TTL_SEC });
}

/**
 * Top-level dispatch for the /api/auth/* prefix. Returns null when the path
 * is not ours (caller continues to TunnelDO routing).
 */
export async function dispatchAuth(
  req: Request,
  env: AuthEnv,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/auth/github/login') {
    return handleGithubLogin(req, env);
  }
  if (req.method === 'GET' && path === CALLBACK_PATH) {
    return handleGithubCallback(req, env);
  }
  if (req.method === 'POST' && path === REFRESH_PATH) {
    return handleRefresh(req, env);
  }
  if (req.method === 'POST' && path === '/api/auth/logout') {
    return handleLogout(req, env);
  }
  if (req.method === 'GET' && path === '/api/auth/me') {
    return handleMe(req, env);
  }
  if (req.method === 'POST' && path === '/api/auth/ws-ticket') {
    return handleWsTicket(req, env);
  }
  return null;
}
