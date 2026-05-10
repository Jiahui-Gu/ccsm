/**
 * R-51a (Task #167): shared OAuth account-linking decision function.
 *
 * Web callback (webOauth.handleGithubCallback) and device-flow callback
 * (deviceFlow.handleDevicePoll) both need to decide, given a freshly
 * authenticated `(provider, provider_sub, email, email_verified, login)`
 * tuple, whether to:
 *
 *   1. login_existing      — (provider, sub) already maps to a user → reuse
 *      that user, refresh display fields (login may have renamed).
 *   2. create_no_email     — no verified email → mint a new user keyed by
 *      a fresh uuid; identity is the only handle. (GitHub user with
 *      private email + no public verified email lands here.)
 *   3. link_to_existing    — verified email already maps to a user → attach
 *      this new identity to that user (e.g. user signed in with GitHub
 *      first, now signs in with Google using same verified primary email).
 *   4. create_new          — verified email not seen before → mint a new
 *      user, write identity + email index.
 *
 *   edge: MultipleAccountsError — verified email index points at user A,
 *   but the identity row records user B (data inconsistency from a prior
 *   incomplete write / race / manual edit). Caller surfaces a 409 so the
 *   user can resolve manually.
 *
 * Modeled after Supabase auth's DetermineAccountLinking (Apache-2.0).
 *   Source: https://github.com/supabase/auth/blob/master/internal/models/linking.go
 *   Commit: 747bf3b15fd9e371c9330e75fe2e5de8b89ce14d
 *   License: Apache-2.0 (compatible with our repo).
 *
 * Differences from Supabase:
 *   - We have no SSO providers and no per-provider linking-domain config —
 *     a single "default" linking domain across web (GitHub) + device-flow
 *     (GitHub) and (v0.5) Google. Sufficient for v0.4 MVP.
 *   - Storage is Cloudflare Durable Objects (KV-style), not Postgres. We
 *     have three keyspaces under the same USER_DO binding (idFromName):
 *       - 'user:<uuid>'              → user blob {user_id, primary_login, ...}
 *       - 'identity:<provider>:<sub>' → identity row
 *       - 'email:<lowercased>'       → {user_id} (verified-only)
 *   - We emit a fresh uuid for new users via crypto.randomUUID(); Supabase
 *     uses Postgres `gen_random_uuid()`. Same semantics.
 *
 * No backfill: v0.4 MVP has no existing users (user-confirmed
 * 2026-05-10), so we ship the new schema without a one-time migration.
 */
import type { AuthEnv } from './bindings';

export type LinkDecision =
  | 'login_existing'
  | 'create_no_email'
  | 'link_to_existing'
  | 'create_new';

export interface LinkInput {
  /** OAuth provider id ('github', future 'google'). */
  provider: string;
  /** Stable provider-side subject id (string form of GitHub numeric id). */
  provider_sub: string;
  /** Provider-side login / username (display only — not a key). */
  login: string;
  /** Provider-side primary email, if known. May be empty string. */
  email: string;
  /** Whether the provider claims the email is verified. */
  email_verified: boolean;
}

export interface LinkResult {
  decision: LinkDecision;
  /** uuid of the resulting user (existing or freshly minted). */
  user_id: string;
  /** Identity row payload that was (or should be) written. */
  identity: {
    user_id: string;
    provider: string;
    provider_sub: string;
    login: string;
    email: string;
    email_verified: boolean;
    created_at: number;
  };
  /** Lowercased email when verified, otherwise empty string. */
  canonical_email: string;
}

export class MultipleAccountsError extends Error {
  constructor(
    public readonly email: string,
    public readonly emailIndexUserId: string,
    public readonly identityUserId: string,
  ) {
    super(
      `multiple-accounts: email=${email} index→${emailIndexUserId} but identity→${identityUserId}`,
    );
    this.name = 'MultipleAccountsError';
  }
}

interface IdentityRecord {
  user_id: string;
  provider: string;
  provider_sub: string;
  login: string;
  email: string;
  email_verified: boolean;
  created_at: number;
}

interface EmailIndexRecord {
  user_id: string;
  created_at: number;
}

interface UserBlob {
  user_id: string;
  primary_login: string;
  created_at: number;
}

/** Look up identity:<provider>:<sub> → row or null. */
async function getIdentity(
  env: AuthEnv,
  provider: string,
  sub: string,
): Promise<IdentityRecord | null> {
  const stub = env.USER_DO.get(
    env.USER_DO.idFromName(`identity:${provider}:${sub}`),
  );
  const res = await stub.fetch(new Request('https://do/getIdentity'));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getIdentity http ${res.status}`);
  return (await res.json()) as IdentityRecord;
}

/** Write identity:<provider>:<sub> row. */
async function putIdentity(
  env: AuthEnv,
  rec: IdentityRecord,
): Promise<void> {
  const stub = env.USER_DO.get(
    env.USER_DO.idFromName(`identity:${rec.provider}:${rec.provider_sub}`),
  );
  const res = await stub.fetch(
    new Request('https://do/setIdentity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec),
    }),
  );
  if (!res.ok) throw new Error(`setIdentity http ${res.status}`);
}

/** Look up email:<lower> → {user_id} or null. */
async function getEmailIndex(
  env: AuthEnv,
  emailLower: string,
): Promise<EmailIndexRecord | null> {
  const stub = env.USER_DO.get(
    env.USER_DO.idFromName(`email:${emailLower}`),
  );
  const res = await stub.fetch(new Request('https://do/getEmailIndex'));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getEmailIndex http ${res.status}`);
  return (await res.json()) as EmailIndexRecord;
}

/** Write email:<lower> → {user_id}. Verified-only callers. */
async function putEmailIndex(
  env: AuthEnv,
  emailLower: string,
  user_id: string,
): Promise<void> {
  const stub = env.USER_DO.get(
    env.USER_DO.idFromName(`email:${emailLower}`),
  );
  const created_at = Math.floor(Date.now() / 1000);
  const res = await stub.fetch(
    new Request('https://do/setEmailIndex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id, created_at }),
    }),
  );
  if (!res.ok) throw new Error(`setEmailIndex http ${res.status}`);
}

/** Read user:<uuid> blob or null. */
async function getUserBlob(
  env: AuthEnv,
  user_id: string,
): Promise<UserBlob | null> {
  const stub = env.USER_DO.get(env.USER_DO.idFromName(`user:${user_id}`));
  const res = await stub.fetch(new Request('https://do/getUserBlob'));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getUserBlob http ${res.status}`);
  return (await res.json()) as UserBlob;
}

/** Write user:<uuid> blob (idempotent — created_at preserved on second call). */
async function putUserBlob(
  env: AuthEnv,
  user_id: string,
  primary_login: string,
): Promise<void> {
  const stub = env.USER_DO.get(env.USER_DO.idFromName(`user:${user_id}`));
  const res = await stub.fetch(
    new Request('https://do/setUserBlob', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id, primary_login }),
    }),
  );
  if (!res.ok) throw new Error(`setUserBlob http ${res.status}`);
}

/**
 * Decide what to do with a freshly authenticated OAuth identity, then write
 * the identity + (verified) email index + user blob through. Returns the
 * decision + user_id so the caller can mint JWTs / refresh tokens.
 *
 * This is the entry point for both web callback and device-flow callback.
 * Idempotent on the (provider, sub) → user_id mapping: subsequent calls with
 * the same (provider, sub) always return the same user_id (login_existing).
 *
 * @throws MultipleAccountsError if the verified email index disagrees with
 *         a discovered identity record's user_id. Caller (web/device handler)
 *         maps to 409.
 */
export async function decideAndLink(
  env: AuthEnv,
  input: LinkInput,
): Promise<LinkResult> {
  const emailLower = input.email_verified
    ? input.email.toLowerCase()
    : '';
  const now = Math.floor(Date.now() / 1000);

  // Branch 1 — (provider, sub) already known → login_existing.
  const existingIdentity = await getIdentity(
    env,
    input.provider,
    input.provider_sub,
  );
  if (existingIdentity !== null) {
    // Refresh display fields (login may have renamed). user_id stays.
    const refreshed: IdentityRecord = {
      ...existingIdentity,
      login: input.login,
      email: input.email,
      email_verified: input.email_verified,
    };
    await putIdentity(env, refreshed);
    // Keep user blob's primary_login in sync so /api/auth/me echoes the
    // current login if the user renamed since last sign-in.
    await putUserBlob(env, existingIdentity.user_id, input.login);
    return {
      decision: 'login_existing',
      user_id: existingIdentity.user_id,
      identity: refreshed,
      canonical_email: emailLower,
    };
  }

  // Branch 2 — no verified email → create a new user keyed by a fresh uuid.
  // The identity is the only handle to this user; email index is not written.
  if (!input.email_verified || emailLower.length === 0) {
    const user_id = crypto.randomUUID();
    const identity: IdentityRecord = {
      user_id,
      provider: input.provider,
      provider_sub: input.provider_sub,
      login: input.login,
      email: input.email,
      email_verified: false,
      created_at: now,
    };
    await putUserBlob(env, user_id, input.login);
    await putIdentity(env, identity);
    return {
      decision: 'create_no_email',
      user_id,
      identity,
      canonical_email: '',
    };
  }

  // Verified email → look up email index.
  const idx = await getEmailIndex(env, emailLower);
  if (idx !== null) {
    // Branch 3 — verified email maps to an existing user. Sanity check:
    // make sure the user blob still exists (defensive against stale index).
    const blob = await getUserBlob(env, idx.user_id);
    if (blob === null) {
      // Stale email index pointing at a deleted user → fall through to
      // create_new with a fresh uuid. This is a self-heal path.
      const user_id = crypto.randomUUID();
      const identity: IdentityRecord = {
        user_id,
        provider: input.provider,
        provider_sub: input.provider_sub,
        login: input.login,
        email: input.email,
        email_verified: true,
        created_at: now,
      };
      await putUserBlob(env, user_id, input.login);
      await putIdentity(env, identity);
      await putEmailIndex(env, emailLower, user_id);
      return {
        decision: 'create_new',
        user_id,
        identity,
        canonical_email: emailLower,
      };
    }
    const identity: IdentityRecord = {
      user_id: idx.user_id,
      provider: input.provider,
      provider_sub: input.provider_sub,
      login: input.login,
      email: input.email,
      email_verified: true,
      created_at: now,
    };
    await putIdentity(env, identity);
    return {
      decision: 'link_to_existing',
      user_id: idx.user_id,
      identity,
      canonical_email: emailLower,
    };
  }

  // Branch 4 — fresh identity + fresh email → create new user.
  const user_id = crypto.randomUUID();
  const identity: IdentityRecord = {
    user_id,
    provider: input.provider,
    provider_sub: input.provider_sub,
    login: input.login,
    email: input.email,
    email_verified: true,
    created_at: now,
  };
  await putUserBlob(env, user_id, input.login);
  await putIdentity(env, identity);
  await putEmailIndex(env, emailLower, user_id);
  return {
    decision: 'create_new',
    user_id,
    identity,
    canonical_email: emailLower,
  };
}

/**
 * Sanity probe used by tests + (optional) callers to detect the
 * MultipleAccountsError edge: identity row's user_id disagrees with the
 * email index's user_id for the same verified email.
 *
 * In normal operation decideAndLink writes identity + email index in the
 * same call, so the two always agree. They can drift when:
 *   - a prior call crashed between writes (race),
 *   - manual storage edits / replay of an old wrangler dump,
 *   - test fixtures seed inconsistent state on purpose.
 */
export async function assertEmailIndexConsistent(
  env: AuthEnv,
  emailLower: string,
  expectedUserId: string,
): Promise<void> {
  const idx = await getEmailIndex(env, emailLower);
  if (idx === null) return; // index not present → nothing to check
  if (idx.user_id !== expectedUserId) {
    throw new MultipleAccountsError(emailLower, idx.user_id, expectedUserId);
  }
}
