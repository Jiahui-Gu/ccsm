/**
 * S4-T2 (Task #121): UserDO skeleton.
 *
 * Per-user Durable Object that owns auth state for one GitHub login:
 *   - github_id / login (set at OAuth callback time, T3)
 *   - refresh_token_hash (rotation, T3/T4)
 *   - created_at
 *
 * T2 scope: KV-like RPC over HTTP (`fetch` handler routes by path). No ws
 * routing, no hibernation API — those land in T5 when the auth middleware
 * starts attaching JWT-validated browsers to per-user UserDO instances.
 *
 * Wire format (internal, called only by other Worker code):
 *   GET  /getLogin                       → 200 JSON | 404
 *   POST /setLogin       { github_id, login }   → 204
 *   POST /setRefreshTokenHash { hash }   → 204
 *   POST /verifyRefreshTokenHash { hash } → 200 { ok: bool }
 *   POST /revoke                         → 204
 *
 * Storage keys are flat strings under `state.storage`. We do NOT use the SQL
 * surface yet (TunnelDO doesn't either) — KV is enough for these primitives.
 */
import { DurableObject } from 'cloudflare:workers';
import type { AuthEnv } from './bindings';

const KEY_GITHUB_ID = 'github_id';
const KEY_LOGIN = 'login';
const KEY_REFRESH_HASH = 'refresh_token_hash';
const KEY_CREATED_AT = 'created_at';

export interface UserLoginRecord {
  github_id: string;
  login: string;
  created_at: number;
}

export class UserDO extends DurableObject<AuthEnv> {
  constructor(state: DurableObjectState, env: AuthEnv) {
    super(state, env);
  }

  private get storage(): DurableObjectStorage {
    return this.ctx.storage;
  }

  /** Persist github_id + login. Sets created_at on first call only. */
  async setLogin(github_id: string, login: string): Promise<void> {
    await this.storage.put(KEY_GITHUB_ID, github_id);
    await this.storage.put(KEY_LOGIN, login);
    const existing = await this.storage.get<number>(KEY_CREATED_AT);
    if (existing === undefined) {
      await this.storage.put(KEY_CREATED_AT, Math.floor(Date.now() / 1000));
    }
  }

  /** Read the persisted login record, or null if setLogin was never called. */
  async getLogin(): Promise<UserLoginRecord | null> {
    const github_id = await this.storage.get<string>(KEY_GITHUB_ID);
    const login = await this.storage.get<string>(KEY_LOGIN);
    const created_at = await this.storage.get<number>(KEY_CREATED_AT);
    if (
      github_id === undefined ||
      login === undefined ||
      created_at === undefined
    ) {
      return null;
    }
    return { github_id, login, created_at };
  }

  /** Store a refresh-token hash (caller responsible for hashing). */
  async setRefreshTokenHash(hash: string): Promise<void> {
    await this.storage.put(KEY_REFRESH_HASH, hash);
  }

  /** Constant-time-ish compare against the stored hash. */
  async verifyRefreshTokenHash(hash: string): Promise<boolean> {
    const stored = await this.storage.get<string>(KEY_REFRESH_HASH);
    if (stored === undefined) return false;
    if (stored.length !== hash.length) return false;
    let mismatch = 0;
    for (let i = 0; i < stored.length; i++) {
      mismatch |= stored.charCodeAt(i) ^ hash.charCodeAt(i);
    }
    return mismatch === 0;
  }

  /** Wipe all stored state for this user (logout / token rotation reset). */
  async revoke(): Promise<void> {
    await this.storage.deleteAll();
  }

  /**
   * Internal RPC fetch handler. Other Worker code calls
   * `env.USER_DO.get(id).fetch(new Request('https://do/<method>', ...))`.
   *
   * Not exposed externally — index.ts routes only public paths into this DO,
   * and there are none yet (T5 adds them).
   */
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/getLogin') {
        const rec = await this.getLogin();
        if (rec === null) return new Response('not found', { status: 404 });
        return Response.json(rec);
      }
      if (req.method === 'POST' && path === '/setLogin') {
        const body = await req.json<{ github_id?: unknown; login?: unknown }>();
        if (typeof body.github_id !== 'string' || typeof body.login !== 'string') {
          return new Response('bad request', { status: 400 });
        }
        await this.setLogin(body.github_id, body.login);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/setRefreshTokenHash') {
        const body = await req.json<{ hash?: unknown }>();
        if (typeof body.hash !== 'string') {
          return new Response('bad request', { status: 400 });
        }
        await this.setRefreshTokenHash(body.hash);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && path === '/verifyRefreshTokenHash') {
        const body = await req.json<{ hash?: unknown }>();
        if (typeof body.hash !== 'string') {
          return new Response('bad request', { status: 400 });
        }
        const ok = await this.verifyRefreshTokenHash(body.hash);
        return Response.json({ ok });
      }
      if (req.method === 'POST' && path === '/revoke') {
        await this.revoke();
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    } catch (err) {
      return new Response('internal error: ' + String(err), { status: 500 });
    }
  }
}
