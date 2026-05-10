/**
 * R-51a (Task #167): UserDO — three-role per-instance storage backing the
 * uuid + identity + email-index schema rebuild.
 *
 * One DurableObject class, three role-disambiguated *instances* — the role
 * is determined by the `idFromName(...)` string the caller passes. There is
 * a single binding (USER_DO) so we don't have to add new wrangler bindings:
 *
 *   - idFromName('user:<uuid>')              → user blob: primary_login,
 *                                              created_at, web_refresh_hash,
 *                                              tunnel_refresh_hash.
 *   - idFromName('identity:<provider>:<sub>') → identity row: user_id +
 *                                              provider + sub + login +
 *                                              email + email_verified.
 *   - idFromName('email:<lower>')            → email index: user_id (only
 *                                              written for verified emails).
 *
 * Methods are role-aware by name (setUserBlob vs setIdentity vs
 * setEmailIndex). Callers (oauthLinker.ts, webOauth.ts, deviceFlow.ts) use
 * the matching idFromName so the storage of one role does not collide with
 * another. Refresh-token hashes still live on the user blob role.
 *
 * Pre-R-51 schema (`user:<github_id>`, `setLogin(github_id, login)`) is
 * REMOVED. v0.4 MVP has no existing users (user-confirmed 2026-05-10), so
 * no backfill is shipped.
 *
 * Wire format (HTTP RPC; called only by other Worker code):
 *   user blob role:
 *     GET  /getUserBlob                      → 200 JSON | 404
 *     POST /setUserBlob       { user_id, primary_login }   → 204
 *     POST /setRefreshTokenHash { hash }     → 204
 *     POST /verifyRefreshTokenHash { hash }  → 200 { ok: bool }
 *     POST /setTunnelRefreshTokenHash { hash } → 204
 *     POST /verifyTunnelRefreshTokenHash { hash } → 200 { ok: bool }
 *     POST /revoke                           → 204
 *   identity role:
 *     GET  /getIdentity                      → 200 JSON | 404
 *     POST /setIdentity       { user_id, provider, provider_sub, login,
 *                                email, email_verified, created_at } → 204
 *   email index role:
 *     GET  /getEmailIndex                    → 200 JSON | 404
 *     POST /setEmailIndex     { user_id, created_at } → 204
 *     POST /clearEmailIndex                  → 204
 */
import { DurableObject } from 'cloudflare:workers';
import type { AuthEnv } from './bindings';

// User-blob storage keys.
const KEY_USER_ID = 'user_id';
const KEY_PRIMARY_LOGIN = 'primary_login';
const KEY_CREATED_AT = 'created_at';
const KEY_REFRESH_HASH = 'refresh_token_hash';
const KEY_TUNNEL_REFRESH_HASH = 'tunnel_refresh_hash';

// Identity-row storage keys.
const KEY_IDENTITY = 'identity_record';

// Email-index storage keys.
const KEY_EMAIL_INDEX = 'email_index_record';

export interface UserBlob {
  user_id: string;
  primary_login: string;
  created_at: number;
}

export interface IdentityRecord {
  user_id: string;
  provider: string;
  provider_sub: string;
  login: string;
  email: string;
  email_verified: boolean;
  created_at: number;
}

export interface EmailIndexRecord {
  user_id: string;
  created_at: number;
}

export class UserDO extends DurableObject<AuthEnv> {
  constructor(state: DurableObjectState, env: AuthEnv) {
    super(state, env);
  }

  private get storage(): DurableObjectStorage {
    return this.ctx.storage;
  }

  // ---------------------------------------------------------------------
  // user:<uuid> role
  // ---------------------------------------------------------------------

  /** Persist user-blob fields. created_at preserved on subsequent calls. */
  async setUserBlob(user_id: string, primary_login: string): Promise<void> {
    await this.storage.put(KEY_USER_ID, user_id);
    await this.storage.put(KEY_PRIMARY_LOGIN, primary_login);
    const existing = await this.storage.get<number>(KEY_CREATED_AT);
    if (existing === undefined) {
      await this.storage.put(KEY_CREATED_AT, Math.floor(Date.now() / 1000));
    }
  }

  /** Read the user blob, or null when nothing has been written yet. */
  async getUserBlob(): Promise<UserBlob | null> {
    const user_id = await this.storage.get<string>(KEY_USER_ID);
    const primary_login = await this.storage.get<string>(KEY_PRIMARY_LOGIN);
    const created_at = await this.storage.get<number>(KEY_CREATED_AT);
    if (
      user_id === undefined ||
      primary_login === undefined ||
      created_at === undefined
    ) {
      return null;
    }
    return { user_id, primary_login, created_at };
  }

  /** Store a web refresh-token hash (caller hashes). */
  async setRefreshTokenHash(hash: string): Promise<void> {
    await this.storage.put(KEY_REFRESH_HASH, hash);
  }

  /** Constant-time-ish compare against the stored web refresh hash. */
  async verifyRefreshTokenHash(hash: string): Promise<boolean> {
    const stored = await this.storage.get<string>(KEY_REFRESH_HASH);
    return constantTimeEq(stored, hash);
  }

  /** Store a tunnel (daemon) refresh-token hash. Independent slot. */
  async setTunnelRefreshTokenHash(hash: string): Promise<void> {
    await this.storage.put(KEY_TUNNEL_REFRESH_HASH, hash);
  }

  async verifyTunnelRefreshTokenHash(hash: string): Promise<boolean> {
    const stored = await this.storage.get<string>(KEY_TUNNEL_REFRESH_HASH);
    return constantTimeEq(stored, hash);
  }

  /** Wipe all stored state (logout / revoke). */
  async revoke(): Promise<void> {
    await this.storage.deleteAll();
  }

  // ---------------------------------------------------------------------
  // identity:<provider>:<sub> role
  // ---------------------------------------------------------------------

  async setIdentity(rec: IdentityRecord): Promise<void> {
    await this.storage.put(KEY_IDENTITY, rec);
  }

  async getIdentity(): Promise<IdentityRecord | null> {
    const rec = await this.storage.get<IdentityRecord>(KEY_IDENTITY);
    return rec ?? null;
  }

  // ---------------------------------------------------------------------
  // email:<lower> role
  // ---------------------------------------------------------------------

  async setEmailIndex(rec: EmailIndexRecord): Promise<void> {
    await this.storage.put(KEY_EMAIL_INDEX, rec);
  }

  async getEmailIndex(): Promise<EmailIndexRecord | null> {
    const rec = await this.storage.get<EmailIndexRecord>(KEY_EMAIL_INDEX);
    return rec ?? null;
  }

  async clearEmailIndex(): Promise<void> {
    await this.storage.delete(KEY_EMAIL_INDEX);
  }

  // ---------------------------------------------------------------------
  // RPC fetch handler
  // ---------------------------------------------------------------------

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      // user-blob role
      if (req.method === 'GET' && path === '/getUserBlob') {
        const rec = await this.getUserBlob();
        if (rec === null) return new Response('not found', { status: 404 });
        return Response.json(rec);
      }
      if (req.method === 'POST' && path === '/setUserBlob') {
        const body = await req.json<{ user_id?: unknown; primary_login?: unknown }>();
        if (typeof body.user_id !== 'string' || typeof body.primary_login !== 'string') {
          return new Response('bad request', { status: 400 });
        }
        await this.setUserBlob(body.user_id, body.primary_login);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/setRefreshTokenHash') {
        return await this.handleSetHash(req, (h) => this.setRefreshTokenHash(h));
      }
      if (req.method === 'POST' && path === '/verifyRefreshTokenHash') {
        return await this.handleVerifyHash(req, (h) => this.verifyRefreshTokenHash(h));
      }
      if (req.method === 'POST' && path === '/setTunnelRefreshTokenHash') {
        return await this.handleSetHash(req, (h) => this.setTunnelRefreshTokenHash(h));
      }
      if (req.method === 'POST' && path === '/verifyTunnelRefreshTokenHash') {
        return await this.handleVerifyHash(req, (h) => this.verifyTunnelRefreshTokenHash(h));
      }
      if (req.method === 'POST' && path === '/revoke') {
        await this.revoke();
        return new Response(null, { status: 204 });
      }

      // identity role
      if (req.method === 'GET' && path === '/getIdentity') {
        const rec = await this.getIdentity();
        if (rec === null) return new Response('not found', { status: 404 });
        return Response.json(rec);
      }
      if (req.method === 'POST' && path === '/setIdentity') {
        const body = await req.json<Partial<IdentityRecord>>();
        if (
          typeof body.user_id !== 'string' ||
          typeof body.provider !== 'string' ||
          typeof body.provider_sub !== 'string' ||
          typeof body.login !== 'string' ||
          typeof body.email !== 'string' ||
          typeof body.email_verified !== 'boolean' ||
          typeof body.created_at !== 'number'
        ) {
          return new Response('bad request', { status: 400 });
        }
        await this.setIdentity(body as IdentityRecord);
        return new Response(null, { status: 204 });
      }

      // email-index role
      if (req.method === 'GET' && path === '/getEmailIndex') {
        const rec = await this.getEmailIndex();
        if (rec === null) return new Response('not found', { status: 404 });
        return Response.json(rec);
      }
      if (req.method === 'POST' && path === '/setEmailIndex') {
        const body = await req.json<{ user_id?: unknown; created_at?: unknown }>();
        if (typeof body.user_id !== 'string' || typeof body.created_at !== 'number') {
          return new Response('bad request', { status: 400 });
        }
        await this.setEmailIndex({ user_id: body.user_id, created_at: body.created_at });
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/clearEmailIndex') {
        await this.clearEmailIndex();
        return new Response(null, { status: 204 });
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      return new Response('internal error: ' + String(err), { status: 500 });
    }
  }

  private async handleSetHash(
    req: Request,
    setter: (hash: string) => Promise<void>,
  ): Promise<Response> {
    const body = await req.json<{ hash?: unknown }>();
    if (typeof body.hash !== 'string') {
      return new Response('bad request', { status: 400 });
    }
    await setter(body.hash);
    return new Response(null, { status: 204 });
  }

  private async handleVerifyHash(
    req: Request,
    verifier: (hash: string) => Promise<boolean>,
  ): Promise<Response> {
    const body = await req.json<{ hash?: unknown }>();
    if (typeof body.hash !== 'string') {
      return new Response('bad request', { status: 400 });
    }
    return Response.json({ ok: await verifier(body.hash) });
  }
}

function constantTimeEq(stored: string | undefined, given: string): boolean {
  if (stored === undefined) return false;
  if (stored.length !== given.length) return false;
  let mismatch = 0;
  for (let i = 0; i < stored.length; i++) {
    mismatch |= stored.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return mismatch === 0;
}
