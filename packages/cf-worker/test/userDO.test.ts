/**
 * R-51a (Task #167): UserDO unit tests for the three-role storage model.
 *
 * UserDO is one DurableObject class with three role-disambiguated instances
 * (caller picks role via idFromName). Tests drive each role independently
 * + the methods that only make sense for that role:
 *   - user blob role:  setUserBlob / getUserBlob / refresh-hash slots /
 *                      tunnel-refresh-hash slots / revoke
 *   - identity role:   setIdentity / getIdentity
 *   - email-index:     setEmailIndex / getEmailIndex / clearEmailIndex
 *
 * Storage isolation across roles is implicit at the binding layer (each
 * idFromName resolves to a separate DO instance with separate storage). At
 * the unit-test layer we instantiate one UserDO per role and confirm the
 * methods round-trip without colliding on key names within one storage.
 *
 * No backfill (user-confirmed 2026-05-10): pre-R-51 setLogin / getLogin
 * methods are gone, no compat shim.
 */
import { describe, expect, it } from 'vitest';

interface FakeStorage {
  data: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  deleteAll(): Promise<void>;
}

function makeStorage(): FakeStorage {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.has(key) ? (data.get(key) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    async deleteAll(): Promise<void> {
      data.clear();
    },
  };
}

function makeState(storage: FakeStorage): DurableObjectState {
  return { storage } as unknown as DurableObjectState;
}

const fakeEnv = {} as unknown as import('../src/auth/bindings').AuthEnv;

async function loadDO() {
  const mod = await import('../src/auth/userDO');
  return mod.UserDO;
}

describe('UserDO — user blob role', () => {
  it('setUserBlob then getUserBlob returns the persisted record', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);

    expect(await inst.getUserBlob()).toBeNull();

    await inst.setUserBlob('uuid-abc', 'octocat');
    const rec = await inst.getUserBlob();
    expect(rec).not.toBeNull();
    expect(rec?.user_id).toBe('uuid-abc');
    expect(rec?.primary_login).toBe('octocat');
    expect(typeof rec?.created_at).toBe('number');
    expect(rec!.created_at).toBeGreaterThan(0);
  });

  it('setUserBlob called twice keeps the original created_at', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);

    await inst.setUserBlob('uuid-abc', 'octocat');
    const rec1 = await inst.getUserBlob();
    await new Promise((r) => setTimeout(r, 1100));
    await inst.setUserBlob('uuid-abc', 'octocat-renamed');
    const rec2 = await inst.getUserBlob();
    expect(rec2?.created_at).toBe(rec1?.created_at);
    expect(rec2?.primary_login).toBe('octocat-renamed');
  });

  it('verifyRefreshTokenHash matches positive sample', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.setRefreshTokenHash('hash-abc-123');
    expect(await inst.verifyRefreshTokenHash('hash-abc-123')).toBe(true);
  });

  it('verifyRefreshTokenHash rejects negative samples', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    expect(await inst.verifyRefreshTokenHash('hash-abc-123')).toBe(false);
    await inst.setRefreshTokenHash('hash-abc-123');
    expect(await inst.verifyRefreshTokenHash('hash-abc-124')).toBe(false);
    expect(await inst.verifyRefreshTokenHash('hash-abc-12')).toBe(false);
    expect(await inst.verifyRefreshTokenHash('')).toBe(false);
  });

  it('tunnel refresh hash is independent of web refresh hash', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.setRefreshTokenHash('web-hash');
    await inst.setTunnelRefreshTokenHash('tunnel-hash');
    expect(await inst.verifyRefreshTokenHash('web-hash')).toBe(true);
    expect(await inst.verifyRefreshTokenHash('tunnel-hash')).toBe(false);
    expect(await inst.verifyTunnelRefreshTokenHash('tunnel-hash')).toBe(true);
    expect(await inst.verifyTunnelRefreshTokenHash('web-hash')).toBe(false);
  });

  it('revoke wipes user blob + refresh hashes', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.setUserBlob('uuid-1', 'a');
    await inst.setRefreshTokenHash('h1');
    await inst.setTunnelRefreshTokenHash('h2');
    await inst.revoke();
    expect(await inst.getUserBlob()).toBeNull();
    expect(await inst.verifyRefreshTokenHash('h1')).toBe(false);
    expect(await inst.verifyTunnelRefreshTokenHash('h2')).toBe(false);
  });

  it('fetch GET /getUserBlob 404 before set, 200 JSON after', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r1 = await inst.fetch(new Request('https://do/getUserBlob'));
    expect(r1.status).toBe(404);
    await inst.setUserBlob('uuid-42', 'alice');
    const r2 = await inst.fetch(new Request('https://do/getUserBlob'));
    expect(r2.status).toBe(200);
    const json = (await r2.json()) as { user_id: string; primary_login: string };
    expect(json.user_id).toBe('uuid-42');
    expect(json.primary_login).toBe('alice');
  });

  it('fetch POST /setUserBlob persists, then GET /getUserBlob returns it', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r1 = await inst.fetch(
      new Request('https://do/setUserBlob', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'uuid-7', primary_login: 'bob' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(r1.status).toBe(204);
    const r2 = await inst.fetch(new Request('https://do/getUserBlob'));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { primary_login: string }).primary_login).toBe('bob');
  });

  it('fetch POST /setUserBlob rejects malformed body with 400', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r = await inst.fetch(
      new Request('https://do/setUserBlob', {
        method: 'POST',
        body: JSON.stringify({ primary_login: 'no-uid' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(r.status).toBe(400);
  });

  it('fetch /verifyRefreshTokenHash returns { ok } JSON', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.fetch(
      new Request('https://do/setRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 'h-1' }),
      }),
    );
    const ok = await inst.fetch(
      new Request('https://do/verifyRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 'h-1' }),
      }),
    );
    expect(await ok.json()).toEqual({ ok: true });
    const bad = await inst.fetch(
      new Request('https://do/verifyRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 'h-2' }),
      }),
    );
    expect(await bad.json()).toEqual({ ok: false });
  });

  it('fetch /setTunnelRefreshTokenHash + /verifyTunnelRefreshTokenHash round-trip', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const set = await inst.fetch(
      new Request('https://do/setTunnelRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 't-hash' }),
      }),
    );
    expect(set.status).toBe(204);
    const ok = await inst.fetch(
      new Request('https://do/verifyTunnelRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 't-hash' }),
      }),
    );
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('fetch /revoke clears state', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.setUserBlob('uuid-1', 'a');
    const r = await inst.fetch(new Request('https://do/revoke', { method: 'POST' }));
    expect(r.status).toBe(204);
    expect(await inst.getUserBlob()).toBeNull();
  });

  it('fetch unknown path returns 404', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r = await inst.fetch(new Request('https://do/nope'));
    expect(r.status).toBe(404);
  });
});

describe('UserDO — identity role', () => {
  it('setIdentity / getIdentity round-trip the full record', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    expect(await inst.getIdentity()).toBeNull();
    const rec = {
      user_id: 'uuid-1',
      provider: 'github',
      provider_sub: '12345',
      login: 'octocat',
      email: 'oct@example.com',
      email_verified: true,
      created_at: 1700000000,
    };
    await inst.setIdentity(rec);
    expect(await inst.getIdentity()).toEqual(rec);
  });

  it('fetch GET /getIdentity 404 before set, 200 after', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r1 = await inst.fetch(new Request('https://do/getIdentity'));
    expect(r1.status).toBe(404);
    await inst.setIdentity({
      user_id: 'uuid-1',
      provider: 'github',
      provider_sub: '7',
      login: 'a',
      email: '',
      email_verified: false,
      created_at: 1700000000,
    });
    const r2 = await inst.fetch(new Request('https://do/getIdentity'));
    expect(r2.status).toBe(200);
    const j = (await r2.json()) as { provider_sub: string };
    expect(j.provider_sub).toBe('7');
  });

  it('fetch POST /setIdentity rejects malformed body with 400', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r = await inst.fetch(
      new Request('https://do/setIdentity', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'u', provider: 'github' /* missing fields */ }),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('fetch POST /setIdentity persists then GET returns it', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const rec = {
      user_id: 'uuid-9',
      provider: 'github',
      provider_sub: '99',
      login: 'carol',
      email: 'c@x.com',
      email_verified: true,
      created_at: 1700000001,
    };
    const set = await inst.fetch(
      new Request('https://do/setIdentity', {
        method: 'POST',
        body: JSON.stringify(rec),
      }),
    );
    expect(set.status).toBe(204);
    const r2 = await inst.fetch(new Request('https://do/getIdentity'));
    expect(await r2.json()).toEqual(rec);
  });
});

describe('UserDO — email-index role', () => {
  it('setEmailIndex / getEmailIndex round-trip', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    expect(await inst.getEmailIndex()).toBeNull();
    await inst.setEmailIndex({ user_id: 'uuid-1', created_at: 1700000000 });
    expect(await inst.getEmailIndex()).toEqual({
      user_id: 'uuid-1',
      created_at: 1700000000,
    });
  });

  it('clearEmailIndex removes the record', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.setEmailIndex({ user_id: 'uuid-1', created_at: 1 });
    await inst.clearEmailIndex();
    expect(await inst.getEmailIndex()).toBeNull();
  });

  it('fetch /setEmailIndex + /getEmailIndex + /clearEmailIndex round-trip', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r1 = await inst.fetch(new Request('https://do/getEmailIndex'));
    expect(r1.status).toBe(404);
    const set = await inst.fetch(
      new Request('https://do/setEmailIndex', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'uuid-7', created_at: 1700000000 }),
      }),
    );
    expect(set.status).toBe(204);
    const get = await inst.fetch(new Request('https://do/getEmailIndex'));
    expect(get.status).toBe(200);
    const j = (await get.json()) as { user_id: string };
    expect(j.user_id).toBe('uuid-7');
    const clr = await inst.fetch(
      new Request('https://do/clearEmailIndex', { method: 'POST' }),
    );
    expect(clr.status).toBe(204);
    const get2 = await inst.fetch(new Request('https://do/getEmailIndex'));
    expect(get2.status).toBe(404);
  });

  it('fetch POST /setEmailIndex rejects malformed body with 400', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r = await inst.fetch(
      new Request('https://do/setEmailIndex', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'u' /* no created_at */ }),
      }),
    );
    expect(r.status).toBe(400);
  });
});
