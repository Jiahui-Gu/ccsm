/**
 * R-51a (Task #167): oauthLinker — 4-branch decision + MultipleAccountsError.
 *
 * Modeled after Supabase auth's DetermineAccountLinking
 *   (https://github.com/supabase/auth/blob/master/internal/models/linking.go,
 *    commit 747bf3b15fd9e371c9330e75fe2e5de8b89ce14d, Apache-2.0).
 *
 * The 4 branches we cover end-to-end through decideAndLink, plus the
 * MultipleAccountsError edge surfaced by assertEmailIndexConsistent.
 *
 * We back the worker's USER_DO binding with an in-memory map keyed by
 * idFromName(...) string so each role-disambiguated DO instance has its
 * own storage — mirroring production behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEmailIndexConsistent,
  decideAndLink,
  MultipleAccountsError,
  type LinkInput,
} from '../src/auth/oauthLinker';
import type { AuthEnv } from '../src/auth/bindings';

interface DoInstanceState {
  data: Map<string, unknown>;
}

function makeUserDoNamespace(): {
  ns: DurableObjectNamespace;
  instances: Map<string, DoInstanceState>;
} {
  const instances = new Map<string, DoInstanceState>();
  function getOrCreate(name: string): DoInstanceState {
    let inst = instances.get(name);
    if (!inst) {
      inst = { data: new Map() };
      instances.set(name, inst);
    }
    return inst;
  }
  function makeStub(name: string): DurableObjectStub {
    const inst = getOrCreate(name);
    return {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;
        const get = <T,>(k: string): T | undefined =>
          inst.data.has(k) ? (inst.data.get(k) as T) : undefined;
        const put = (k: string, v: unknown) => inst.data.set(k, v);

        // user-blob role
        if (req.method === 'GET' && path === '/getUserBlob') {
          const user_id = get<string>('user_id');
          const primary_login = get<string>('primary_login');
          const created_at = get<number>('created_at');
          if (user_id === undefined || primary_login === undefined || created_at === undefined) {
            return new Response('not found', { status: 404 });
          }
          return Response.json({ user_id, primary_login, created_at });
        }
        if (req.method === 'POST' && path === '/setUserBlob') {
          const body = (await req.json()) as { user_id: string; primary_login: string };
          put('user_id', body.user_id);
          put('primary_login', body.primary_login);
          if (get<number>('created_at') === undefined) {
            put('created_at', Math.floor(Date.now() / 1000));
          }
          return new Response(null, { status: 204 });
        }

        // identity role
        if (req.method === 'GET' && path === '/getIdentity') {
          const rec = get<unknown>('identity_record');
          if (rec === undefined) return new Response('not found', { status: 404 });
          return Response.json(rec);
        }
        if (req.method === 'POST' && path === '/setIdentity') {
          const body = await req.json();
          put('identity_record', body);
          return new Response(null, { status: 204 });
        }

        // email-index role
        if (req.method === 'GET' && path === '/getEmailIndex') {
          const rec = get<unknown>('email_index_record');
          if (rec === undefined) return new Response('not found', { status: 404 });
          return Response.json(rec);
        }
        if (req.method === 'POST' && path === '/setEmailIndex') {
          const body = await req.json();
          put('email_index_record', body);
          return new Response(null, { status: 204 });
        }

        return new Response('not found', { status: 404 });
      },
    } as unknown as DurableObjectStub;
  }
  const ns = {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => makeStub((id as unknown as { name: string }).name),
  } as unknown as DurableObjectNamespace;
  return { ns, instances };
}

function makeEnv(): { env: AuthEnv; instances: Map<string, DoInstanceState> } {
  const { ns, instances } = makeUserDoNamespace();
  const env = {
    TUNNEL: undefined as unknown as DurableObjectNamespace,
    GITHUB_OAUTH_CLIENT_ID: 'cid',
    GITHUB_OAUTH_CLIENT_SECRET: 'csec',
    JWT_SIGNING_KEY: 'aa'.repeat(32),
    JWT_REFRESH_SIGNING_KEY: 'bb'.repeat(32),
    USER_DO: ns,
  } as AuthEnv;
  return { env, instances };
}

const baseInput = (over: Partial<LinkInput> = {}): LinkInput => ({
  provider: 'github',
  provider_sub: '12345',
  login: 'octocat',
  email: 'octocat@example.com',
  email_verified: true,
  ...over,
});

describe('decideAndLink — 4 branches (Supabase model)', () => {
  it('Branch 4 (create_new): fresh provider+sub + verified email → mint user, write all three rows', async () => {
    const { env, instances } = makeEnv();
    const res = await decideAndLink(env, baseInput());
    expect(res.decision).toBe('create_new');
    expect(res.user_id).toMatch(/^[0-9a-f-]{36}$/i); // uuid v4 shape
    expect(res.canonical_email).toBe('octocat@example.com');

    // Identity row keyed by identity:github:12345 written.
    const identityInst = instances.get('identity:github:12345');
    expect(identityInst).toBeDefined();
    const identityRec = identityInst!.data.get('identity_record') as {
      user_id: string;
      provider: string;
      email_verified: boolean;
    };
    expect(identityRec.user_id).toBe(res.user_id);
    expect(identityRec.provider).toBe('github');
    expect(identityRec.email_verified).toBe(true);

    // Email index keyed by email:octocat@example.com written.
    const emailInst = instances.get('email:octocat@example.com');
    expect(emailInst).toBeDefined();
    expect((emailInst!.data.get('email_index_record') as { user_id: string }).user_id).toBe(res.user_id);

    // User blob keyed by user:<uuid> written.
    const userInst = instances.get(`user:${res.user_id}`);
    expect(userInst).toBeDefined();
    expect(userInst!.data.get('primary_login')).toBe('octocat');
  });

  it('Branch 1 (login_existing): same (provider, sub) seen again returns the same user_id', async () => {
    const { env } = makeEnv();
    const r1 = await decideAndLink(env, baseInput());
    const r2 = await decideAndLink(env, baseInput());
    expect(r2.decision).toBe('login_existing');
    expect(r2.user_id).toBe(r1.user_id);
  });

  it('Branch 1 refreshes login on rename: identity row updated, user_id stable', async () => {
    const { env } = makeEnv();
    const r1 = await decideAndLink(env, baseInput({ login: 'octocat' }));
    const r2 = await decideAndLink(env, baseInput({ login: 'octocat-renamed' }));
    expect(r2.decision).toBe('login_existing');
    expect(r2.user_id).toBe(r1.user_id);
    expect(r2.identity.login).toBe('octocat-renamed');
  });

  it('Branch 2 (create_no_email): no verified email → fresh user, no email index', async () => {
    const { env, instances } = makeEnv();
    const res = await decideAndLink(
      env,
      baseInput({ email: '', email_verified: false }),
    );
    expect(res.decision).toBe('create_no_email');
    expect(res.canonical_email).toBe('');
    // No email-index row written.
    expect(instances.get('email:')).toBeUndefined();
    expect([...instances.keys()].some((k) => k.startsWith('email:'))).toBe(false);
    // Identity row still written, with email_verified=false.
    const identityRec = instances.get('identity:github:12345')!.data.get('identity_record') as {
      email_verified: boolean;
    };
    expect(identityRec.email_verified).toBe(false);
  });

  it('Branch 2: email present but unverified → still create_no_email, no email index', async () => {
    const { env, instances } = makeEnv();
    const res = await decideAndLink(
      env,
      baseInput({ email: 'private@example.com', email_verified: false }),
    );
    expect(res.decision).toBe('create_no_email');
    expect([...instances.keys()].some((k) => k.startsWith('email:'))).toBe(false);
  });

  it('Branch 3 (link_to_existing): different provider+sub but same verified email → links to existing user', async () => {
    const { env } = makeEnv();
    const first = await decideAndLink(
      env,
      baseInput({ provider: 'github', provider_sub: '12345', email: 'shared@example.com' }),
    );
    expect(first.decision).toBe('create_new');

    // Second sign-in with same email but different (provider, sub).
    const second = await decideAndLink(
      env,
      baseInput({
        provider: 'google',
        provider_sub: 'google-uid-99',
        login: 'octocat-google',
        email: 'shared@example.com',
      }),
    );
    expect(second.decision).toBe('link_to_existing');
    expect(second.user_id).toBe(first.user_id);
  });

  it('Branch 3 lowercases the email key (case-insensitive matching)', async () => {
    const { env } = makeEnv();
    const first = await decideAndLink(
      env,
      baseInput({ email: 'MixedCase@Example.com' }),
    );
    const second = await decideAndLink(
      env,
      baseInput({
        provider: 'google',
        provider_sub: 'g-1',
        email: 'mixedcase@example.com',
      }),
    );
    expect(second.decision).toBe('link_to_existing');
    expect(second.user_id).toBe(first.user_id);
  });
});

describe('assertEmailIndexConsistent — MultipleAccountsError edge', () => {
  it('throws MultipleAccountsError when email index disagrees with expected user_id', async () => {
    const { env, instances } = makeEnv();
    // Seed an email index pointing at user A.
    instances.set('email:victim@example.com', {
      data: new Map<string, unknown>([
        ['email_index_record', { user_id: 'uuid-A', created_at: 1700000000 }],
      ]),
    });
    await expect(
      assertEmailIndexConsistent(env, 'victim@example.com', 'uuid-B'),
    ).rejects.toBeInstanceOf(MultipleAccountsError);
  });

  it('does not throw when email index agrees with expected user_id', async () => {
    const { env, instances } = makeEnv();
    instances.set('email:ok@example.com', {
      data: new Map<string, unknown>([
        ['email_index_record', { user_id: 'uuid-A', created_at: 1700000000 }],
      ]),
    });
    await expect(
      assertEmailIndexConsistent(env, 'ok@example.com', 'uuid-A'),
    ).resolves.toBeUndefined();
  });

  it('does not throw when email index is absent (no constraint to violate)', async () => {
    const { env } = makeEnv();
    await expect(
      assertEmailIndexConsistent(env, 'never-seen@example.com', 'uuid-X'),
    ).resolves.toBeUndefined();
  });

  it('MultipleAccountsError carries email + both user ids for diagnostics', async () => {
    const { env, instances } = makeEnv();
    instances.set('email:dup@example.com', {
      data: new Map<string, unknown>([
        ['email_index_record', { user_id: 'uuid-A', created_at: 1 }],
      ]),
    });
    try {
      await assertEmailIndexConsistent(env, 'dup@example.com', 'uuid-B');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MultipleAccountsError);
      const e = err as MultipleAccountsError;
      expect(e.email).toBe('dup@example.com');
      expect(e.emailIndexUserId).toBe('uuid-A');
      expect(e.identityUserId).toBe('uuid-B');
    }
  });
});

describe('decideAndLink — self-heal on stale email index', () => {
  it('email index points at deleted user → falls through to create_new with fresh uuid', async () => {
    const { env, instances } = makeEnv();
    // Seed only an email index, no user blob — simulating a stale write.
    instances.set('email:ghost@example.com', {
      data: new Map<string, unknown>([
        ['email_index_record', { user_id: 'uuid-deleted', created_at: 1 }],
      ]),
    });
    const res = await decideAndLink(
      env,
      baseInput({ email: 'ghost@example.com' }),
    );
    expect(res.decision).toBe('create_new');
    expect(res.user_id).not.toBe('uuid-deleted');
    // Email index now points at the freshly minted user.
    const idx = instances.get('email:ghost@example.com')!.data.get('email_index_record') as {
      user_id: string;
    };
    expect(idx.user_id).toBe(res.user_id);
  });
});
