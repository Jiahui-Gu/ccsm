// Daemon-side tunnel-JWT refresh client (Task #153, R-45 audit-P0 F-T-13).
//
// Background
// ----------
// The cloud tunnel JWT minted by the cf-worker (`/api/auth/device/poll` and
// `/api/auth/tunnel/refresh`) has a 24h TTL. The Tauri shell injects the JWT
// into the daemon at spawn time via `CCSM_TUNNEL_JWT` (encoded as the
// `ccsm.<jwt>` ws subprotocol — see tunnel.mts header). Without a refresh
// loop the daemon's tunnel ws would close hard at exp+ε and never recover;
// the user would have to restart the Tauri shell. Production hard-block.
//
// This module owns the daemon side of the refresh loop:
//
//   1. On start(), reads `~/.ccsm/tunnel_jwt` (JSON: tunnel_jwt /
//      tunnel_refresh_token / login — same shape the Tauri shell writes),
//      parses the JWT `exp` claim WITHOUT verifying the signature (the cloud
//      already verified it; we only need the timestamp to schedule a timer).
//   2. Schedules a single-shot timer to fire 1h before exp. If exp is already
//      <= now+1h we fire immediately so a daemon resumed after a long suspend
//      refreshes ASAP.
//   3. On timer fire: POST `<authBase>/api/auth/tunnel/refresh` with body
//      `{ tunnel_refresh_token, login }`. On 200 we get back
//      `{ tunnel_jwt, tunnel_refresh_token }`, atomically rewrite the creds
//      file, update the in-memory copy, invoke `onRefreshed(newJwt)` so the
//      caller can tear the current tunnel ws down + dial a new one with the
//      new subprotocol, and reschedule the next timer off the new exp.
//   4. On any failure (non-2xx, network throw, JSON parse, missing exp in the
//      new JWT) we LOG and stay parked — the existing tunnel keeps running
//      until it actually closes; we do NOT force-disconnect. Refresh is
//      retried on a short backoff (60s) so transient cloud blips self-heal.
//      Permanent failure (401 — refresh token revoked) gives up after
//      logging; the user has to re-login through the SPA.
//
// Why no signature verification: the daemon does NOT have the cf-worker's
// `JWT_REFRESH_SIGNING_KEY` (and shouldn't — secrets live cloud-side). The
// cloud signed the JWT, the cf-worker re-verifies on every ws upgrade
// (subprotocol check), so the daemon trusts the file contents. A tampered
// `exp` here would only cause early/late refresh attempts, not a privilege
// escalation. Same trust model frontend-tauri's `parse_jwt_sub_unverified`
// uses for the F-S-2 owner-bind check.
//
// Threat model: the creds file is %USERPROFILE%/.ccsm or ~/.ccsm with
// 0600/user-only ACL (Tauri shell writes it; we only read+rewrite). A stolen
// file gives the attacker at most one refresh round-trip — once we rotate,
// the old refresh token no longer verifies cloud-side.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Refresh 1 hour before exp.
const REFRESH_LEAD_MS = 60 * 60 * 1000;
// Retry transient failures (network / 5xx) on this cadence.
const RETRY_BACKOFF_MS = 60 * 1000;
// Floor on the next-fire delay so we don't spin if exp is in the past.
const MIN_TIMER_DELAY_MS = 0;

export interface PersistedTunnelCreds {
  tunnel_jwt: string;
  tunnel_refresh_token: string;
  login: string;
}

export interface TunnelRefreshOptions {
  /** Cloud auth base, e.g. `https://cc-sm.pages.dev`. */
  authBase: string;
  /**
   * Initial creds (parsed from `~/.ccsm/tunnel_jwt` by the caller — or
   * provided directly by tests). The client takes a copy and mutates its own
   * in-memory state on each refresh; the caller's object is not mutated.
   */
  creds: PersistedTunnelCreds;
  /**
   * Invoked synchronously after a successful refresh + file rewrite. The
   * caller (daemon main / index.mts) tears the current TunnelClient down and
   * dials a new one whose `subprotocols` carries the new JWT. Failure here is
   * logged but does NOT abort the refresh loop — the next timer still fires.
   */
  onRefreshed: (newJwt: string) => void;
  /** DI seam: HTTP fetch (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** DI seam: timer (defaults to globalThis.setTimeout). */
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (id: ReturnType<typeof setTimeout>) => void;
  /** DI seam: now (defaults to Date.now). */
  nowMs?: () => number;
  /**
   * DI seam: where to write the refreshed creds. Default writes to
   * `~/.ccsm/tunnel_jwt` (same path the Tauri shell uses) with 0600 perms on
   * Unix. Tests inject a stub.
   */
  writeCredsFile?: (creds: PersistedTunnelCreds) => Promise<void>;
}

/**
 * Parse the `exp` (expiration, seconds-since-epoch) claim from a JWT WITHOUT
 * verifying the signature. Returns null on any structural failure. Mirrors
 * frontend-tauri/src-tauri/src/auth.rs `parse_jwt_sub_unverified` modulo the
 * field name. Public for tests.
 */
export function parseJwtExpUnverified(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return null;
  // base64url -> base64 -> Buffer
  let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad === 1) return null;
  let json: string;
  try {
    json = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const exp = (parsed as Record<string, unknown>).exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
  return exp;
}

/** Default creds-file path: `~/.ccsm/tunnel_jwt`. */
export function defaultCredsPath(): string {
  return path.join(os.homedir(), '.ccsm', 'tunnel_jwt');
}

/**
 * Load + JSON-parse `~/.ccsm/tunnel_jwt`. Returns null if the file does not
 * exist OR is malformed. Used by index.mts at boot to decide whether to spin
 * up a refresh client.
 */
export async function readCredsFile(
  filePath: string = defaultCredsPath(),
): Promise<PersistedTunnelCreds | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.tunnel_jwt !== 'string' || obj.tunnel_jwt.length === 0 ||
    typeof obj.tunnel_refresh_token !== 'string' || obj.tunnel_refresh_token.length === 0 ||
    typeof obj.login !== 'string' || obj.login.length === 0
  ) {
    return null;
  }
  return {
    tunnel_jwt: obj.tunnel_jwt,
    tunnel_refresh_token: obj.tunnel_refresh_token,
    login: obj.login,
  };
}

/** Default writer: atomic-ish rewrite, 0600 on Unix. Same model as Tauri shell. */
async function defaultWriteCredsFile(creds: PersistedTunnelCreds): Promise<void> {
  const filePath = defaultCredsPath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const json = JSON.stringify(creds);
  // Truncate + rewrite. Daemon reads at boot only; in-flight refresh updates
  // its in-memory copy via the client itself, so a partial write window has
  // no observable consumer on the same machine.
  if (process.platform === 'win32') {
    // Windows: %USERPROFILE% ACL inheritance suffices (matches the Tauri
    // shell's daemon_mgr::write_token_file rationale).
    await fs.writeFile(filePath, json, { encoding: 'utf8' });
  } else {
    await fs.writeFile(filePath, json, { encoding: 'utf8', mode: 0o600 });
    // chmod again in case the file already existed with looser perms.
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // best-effort
    }
  }
}

export type RefreshState =
  | 'idle'
  | 'scheduled'
  | 'refreshing'
  | 'stopped';

export class TunnelRefreshClient {
  private readonly authBase: string;
  private readonly onRefreshed: (newJwt: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly setTimeoutImpl: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutImpl: (id: ReturnType<typeof setTimeout>) => void;
  private readonly nowMs: () => number;
  private readonly writeCredsFile: (creds: PersistedTunnelCreds) => Promise<void>;

  private creds: PersistedTunnelCreds;
  private state: RefreshState = 'idle';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TunnelRefreshOptions) {
    this.authBase = opts.authBase.replace(/\/+$/, '');
    this.creds = { ...opts.creds };
    this.onRefreshed = opts.onRefreshed;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((id) => clearTimeout(id));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.writeCredsFile = opts.writeCredsFile ?? defaultWriteCredsFile;
  }

  getState(): RefreshState {
    return this.state;
  }

  /** Current JWT in memory (reflects the most recent successful refresh). */
  getCurrentJwt(): string {
    return this.creds.tunnel_jwt;
  }

  /**
   * Schedule the next refresh based on the current creds' JWT exp claim.
   * Idempotent: subsequent calls cancel any prior timer first.
   */
  start(): void {
    if (this.state === 'stopped') return;
    this.scheduleNext();
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.state === 'stopped') return;
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    const exp = parseJwtExpUnverified(this.creds.tunnel_jwt);
    if (exp === null) {
      console.warn('[ccsm/tunnel-refresh] cannot parse exp, refresh disabled');
      this.state = 'idle';
      return;
    }
    const expMs = exp * 1000;
    const fireAt = expMs - REFRESH_LEAD_MS;
    const delay = Math.max(MIN_TIMER_DELAY_MS, fireAt - this.nowMs());
    console.error(
      `[ccsm/tunnel-refresh] next refresh in ${delay}ms (exp=${exp}, lead=${REFRESH_LEAD_MS}ms)`,
    );
    this.state = 'scheduled';
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this.fireRefresh();
    }, delay);
  }

  private scheduleRetry(): void {
    if (this.state === 'stopped') return;
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    console.error(`[ccsm/tunnel-refresh] retry in ${RETRY_BACKOFF_MS}ms`);
    this.state = 'scheduled';
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      void this.fireRefresh();
    }, RETRY_BACKOFF_MS);
  }

  private async fireRefresh(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'refreshing';
    const url = `${this.authBase}/api/auth/tunnel/refresh`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tunnel_refresh_token: this.creds.tunnel_refresh_token,
          login: this.creds.login,
        }),
      });
    } catch (err) {
      console.warn(
        '[ccsm/tunnel-refresh] network error:',
        (err as Error).message,
      );
      this.scheduleRetry();
      return;
    }
    if (response.status === 401 || response.status === 404) {
      // Permanent: refresh token revoked or user unknown. The user has to
      // re-login through the SPA. Park (no retry, no rethrow).
      console.warn(
        `[ccsm/tunnel-refresh] permanent failure status=${response.status}, refresh disabled until restart`,
      );
      this.state = 'idle';
      return;
    }
    if (!response.ok) {
      console.warn(
        `[ccsm/tunnel-refresh] transient failure status=${response.status}, will retry`,
      );
      this.scheduleRetry();
      return;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      console.warn(
        '[ccsm/tunnel-refresh] bad json response:',
        (err as Error).message,
      );
      this.scheduleRetry();
      return;
    }
    if (body === null || typeof body !== 'object') {
      console.warn('[ccsm/tunnel-refresh] response not an object');
      this.scheduleRetry();
      return;
    }
    const obj = body as Record<string, unknown>;
    if (
      typeof obj.tunnel_jwt !== 'string' || obj.tunnel_jwt.length === 0 ||
      typeof obj.tunnel_refresh_token !== 'string' || obj.tunnel_refresh_token.length === 0
    ) {
      console.warn('[ccsm/tunnel-refresh] response missing fields');
      this.scheduleRetry();
      return;
    }
    if (parseJwtExpUnverified(obj.tunnel_jwt) === null) {
      console.warn('[ccsm/tunnel-refresh] new JWT has no parseable exp');
      this.scheduleRetry();
      return;
    }
    // Persist before notifying so a crash between rotate and ws-redial leaves
    // the new (already rotated cloud-side) creds on disk for next boot.
    const nextCreds: PersistedTunnelCreds = {
      tunnel_jwt: obj.tunnel_jwt,
      tunnel_refresh_token: obj.tunnel_refresh_token,
      login: this.creds.login,
    };
    try {
      await this.writeCredsFile(nextCreds);
    } catch (err) {
      console.warn(
        '[ccsm/tunnel-refresh] persist failed:',
        (err as Error).message,
      );
      // Don't update in-memory creds — keep refresh_token in sync with disk.
      this.scheduleRetry();
      return;
    }
    this.creds = nextCreds;
    console.error('[ccsm/tunnel-refresh] refresh ok, redialing tunnel');
    try {
      this.onRefreshed(nextCreds.tunnel_jwt);
    } catch (err) {
      console.warn(
        '[ccsm/tunnel-refresh] onRefreshed threw:',
        (err as Error).message,
      );
      // Continue regardless — the next timer will still fire.
    }
    this.scheduleNext();
  }
}
