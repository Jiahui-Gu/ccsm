/**
 * S4-T2 (Task #121): UserDO storage + RPC unit tests.
 *
 * Mirrors the TunnelDO test strategy — fake the DurableObjectState surface
 * (here: just `storage` with get/put/deleteAll) and drive the DO directly.
 * Uses the same `cloudflare:workers` stub as TunnelDO via vitest alias.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface FakeStorage {
  data: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
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

beforeEach(() => {
  // No globals to install — UserDO uses only `Date.now`, `URL`, `Response`.
});

afterEach(() => {
  /* nothing to restore */
});

describe('UserDO', () => {
  it('setLogin then getLogin returns the persisted record', async () => {
    const UserDO = await loadDO();
    const storage = makeStorage();
    const inst = new UserDO(makeState(storage), fakeEnv);

    expect(await inst.getLogin()).toBeNull();

    await inst.setLogin('12345', 'octocat');
    const rec = await inst.getLogin();
    expect(rec).not.toBeNull();
    expect(rec?.github_id).toBe('12345');
    expect(rec?.login).toBe('octocat');
    expect(typeof rec?.created_at).toBe('number');
    expect(rec!.created_at).toBeGreaterThan(0);
  });

  it('setLogin called twice keeps the original created_at', async () => {
    const UserDO = await loadDO();
    const storage = makeStorage();
    const inst = new UserDO(makeState(storage), fakeEnv);

    await inst.setLogin('12345', 'octocat');
    const rec1 = await inst.getLogin();
    // Force a clock-tick so a second created_at would visibly differ.
    await new Promise((r) => setTimeout(r, 1100));
    await inst.setLogin('12345', 'octocat-renamed');
    const rec2 = await inst.getLogin();
    expect(rec2?.created_at).toBe(rec1?.created_at);
    expect(rec2?.login).toBe('octocat-renamed');
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
    // No hash stored yet → false.
    expect(await inst.verifyRefreshTokenHash('hash-abc-123')).toBe(false);

    await inst.setRefreshTokenHash('hash-abc-123');
    expect(await inst.verifyRefreshTokenHash('hash-abc-124')).toBe(false);
    expect(await inst.verifyRefreshTokenHash('hash-abc-12')).toBe(false); // length differs
    expect(await inst.verifyRefreshTokenHash('')).toBe(false);
  });

  it('revoke wipes login + refresh hash', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.setLogin('1', 'a');
    await inst.setRefreshTokenHash('h');
    await inst.revoke();
    expect(await inst.getLogin()).toBeNull();
    expect(await inst.verifyRefreshTokenHash('h')).toBe(false);
  });

  it('fetch /getLogin returns 404 before setLogin, 200 JSON after', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);

    const r1 = await inst.fetch(new Request('https://do/getLogin'));
    expect(r1.status).toBe(404);

    await inst.setLogin('42', 'alice');
    const r2 = await inst.fetch(new Request('https://do/getLogin'));
    expect(r2.status).toBe(200);
    const json = (await r2.json()) as { github_id: string; login: string };
    expect(json.github_id).toBe('42');
    expect(json.login).toBe('alice');
  });

  it('fetch POST /setLogin persists, then GET /getLogin returns it', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r1 = await inst.fetch(
      new Request('https://do/setLogin', {
        method: 'POST',
        body: JSON.stringify({ github_id: '7', login: 'bob' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(r1.status).toBe(204);
    const r2 = await inst.fetch(new Request('https://do/getLogin'));
    expect(r2.status).toBe(200);
    expect((await r2.json() as { login: string }).login).toBe('bob');
  });

  it('fetch /setLogin rejects malformed body with 400', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r = await inst.fetch(
      new Request('https://do/setLogin', {
        method: 'POST',
        body: JSON.stringify({ login: 'no-id' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(r.status).toBe(400);
  });

  it('fetch /verifyRefreshTokenHash returns { ok } JSON', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.fetch(new Request('https://do/setRefreshTokenHash', {
      method: 'POST',
      body: JSON.stringify({ hash: 'h-1' }),
    }));
    const okRes = await inst.fetch(new Request('https://do/verifyRefreshTokenHash', {
      method: 'POST',
      body: JSON.stringify({ hash: 'h-1' }),
    }));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true });

    const bad = await inst.fetch(new Request('https://do/verifyRefreshTokenHash', {
      method: 'POST',
      body: JSON.stringify({ hash: 'h-2' }),
    }));
    expect(await bad.json()).toEqual({ ok: false });
  });

  it('fetch /revoke clears state', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    await inst.setLogin('1', 'a');
    const r = await inst.fetch(new Request('https://do/revoke', { method: 'POST' }));
    expect(r.status).toBe(204);
    expect(await inst.getLogin()).toBeNull();
  });

  it('fetch unknown path returns 404', async () => {
    const UserDO = await loadDO();
    const inst = new UserDO(makeState(makeStorage()), fakeEnv);
    const r = await inst.fetch(new Request('https://do/nope'));
    expect(r.status).toBe(404);
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
    const bad = await inst.fetch(
      new Request('https://do/verifyTunnelRefreshTokenHash', {
        method: 'POST',
        body: JSON.stringify({ hash: 'nope' }),
      }),
    );
    expect(await bad.json()).toEqual({ ok: false });
  });
});
