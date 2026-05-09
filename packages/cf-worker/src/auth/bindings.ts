/**
 * S4-T2 (Task #121): augmented Env for the auth subsystem.
 *
 * Extends the base `Env` (TUNNEL DO binding, defined in `../index.ts`) with
 * the GitHub App credentials, JWT signing keys, and the UserDO namespace
 * binding. Set in production via `wrangler secret put` (see wrangler.toml +
 * docs/S4-SETUP.md). Local dev: copy `.dev.vars.example` → `.dev.vars`.
 *
 * Routes / handlers introduced in T3 (OAuth callback) and T5 (JWT middleware)
 * will type-narrow against `AuthEnv` so the bindings flow through naturally.
 */
import type { Env } from '../index';

export interface AuthEnv extends Env {
  /** GitHub OAuth App client id (public-ish, but stored as secret for parity). */
  GITHUB_APP_CLIENT_ID: string;
  /** GitHub OAuth App client secret. wrangler secret. */
  GITHUB_APP_CLIENT_SECRET: string;
  /** HS256 hex key for short-lived browser session JWTs (kind='web'). */
  JWT_SIGNING_KEY: string;
  /** HS256 hex key for refresh tokens / per-tunnel JWTs (kind='tunnel'). */
  JWT_REFRESH_SIGNING_KEY: string;
  /** Per-user Durable Object namespace (UserDO). idFromName(login). */
  USER_DO: DurableObjectNamespace;
}
