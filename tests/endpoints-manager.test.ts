import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  EndpointsManager,
  type KeyCrypto,
  __test__,
} from '../electron/endpoints-manager';
import { __setDbForTests } from '../electron/db';

// XOR "encryption" stand-in so tests don't need Electron's safeStorage. Round-
// trip fidelity is all that matters here; we're exercising DB + manager logic.
function makeCrypto(available = true): KeyCrypto {
  const MASK = 0x5a;
  return {
    isAvailable: () => available,
    encrypt: (plain) => {
      const buf = Buffer.from(plain, 'utf8');
      return Buffer.from(buf.map((b) => b ^ MASK));
    },
    decrypt: (cipher) =>
      Buffer.from(Array.from(cipher).map((b) => b ^ MASK)).toString('utf8'),
  };
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  __setDbForTests(db);
  return db;
}

describe('EndpointsManager: CRUD + encryption roundtrip', () => {
  beforeEach(() => {
    freshDb();
  });

  it('adds an endpoint and stores the key encrypted', () => {
    const crypto = makeCrypto();
    const mgr = new EndpointsManager({ crypto });
    const row = mgr.addEndpoint({
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-abc',
      isDefault: true,
    });
    expect(row.id).toBeTruthy();
    expect(row.isDefault).toBe(true);
    expect(row.lastStatus).toBe('unchecked');

    // Round-trip the key via the manager (no plaintext columns read from DB).
    const plain = mgr.getPlainKey(row.id);
    expect(plain).toBe('sk-ant-abc');
  });

  it('lists endpoints with defaults first', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto() });
    mgr.addEndpoint({ name: 'A', baseUrl: 'https://a' });
    mgr.addEndpoint({ name: 'B', baseUrl: 'https://b', isDefault: true });
    const list = mgr.listEndpoints();
    expect(list[0].name).toBe('B');
    expect(list[0].isDefault).toBe(true);
    expect(list[1].isDefault).toBe(false);
  });

  it('setting a new default unsets the previous one', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto() });
    const a = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', isDefault: true });
    const b = mgr.addEndpoint({ name: 'B', baseUrl: 'https://b', isDefault: true });
    const after = mgr.listEndpoints();
    expect(after.find((x) => x.id === a.id)?.isDefault).toBe(false);
    expect(after.find((x) => x.id === b.id)?.isDefault).toBe(true);
  });

  it('updateEndpoint with apiKey=null clears the key', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto() });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk-1' });
    expect(mgr.getPlainKey(row.id)).toBe('sk-1');
    mgr.updateEndpoint(row.id, { apiKey: null });
    expect(mgr.getPlainKey(row.id)).toBeNull();
  });

  it('removeEndpoint cascades to endpoint_models and promotes a new default', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto() });
    const a = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', isDefault: true });
    const b = mgr.addEndpoint({ name: 'B', baseUrl: 'https://b' });
    // Mock a refresh for A so models exist to cascade-delete.
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, anthropicPage(['m-1'])));
    const mgr2 = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    // reuse the existing DB — mgr and mgr2 share the in-memory DB
    return (async () => {
      await mgr2.refreshModels(a.id);
      expect(mgr.listModels(a.id).length).toBe(1);
      mgr.removeEndpoint(a.id);
      expect(mgr.getEndpoint(a.id)).toBeNull();
      expect(mgr.listModels(a.id).length).toBe(0);
      // b should now be default
      expect(mgr.getEndpoint(b.id)?.isDefault).toBe(true);
    })();
  });

  it('does not persist a key when encryption is unavailable', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto(false) });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk-1' });
    expect(mgr.getPlainKey(row.id)).toBeNull();
  });
});

function anthropicPage(ids: string[], has_more = false, last_id?: string) {
  return {
    data: ids.map((id) => ({ id, display_name: id.toUpperCase(), type: 'model' })),
    has_more,
    last_id: last_id ?? ids[ids.length - 1] ?? null,
  };
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('EndpointsManager: refreshModels with pagination', () => {
  beforeEach(() => freshDb());

  it('paginates through has_more and writes every model', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, anthropicPage(['m-1', 'm-2'], true, 'm-2')))
      .mockResolvedValueOnce(fakeResponse(200, anthropicPage(['m-3'], false, 'm-3')));
    const mgr = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    const res = await mgr.refreshModels(row.id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.count).toBe(3);
    const models = mgr.listModels(row.id).map((m) => m.modelId).sort();
    expect(models).toEqual(['m-1', 'm-2', 'm-3']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call must include after_id from the first page's last_id.
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain('after_id=m-2');
  });

  it('marks endpoint error on 401 and keeps cached models', async () => {
    const goodFetch = vi.fn().mockResolvedValueOnce(
      fakeResponse(200, anthropicPage(['m-1']))
    );
    const mgrGood = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: goodFetch });
    const row = mgrGood.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    await mgrGood.refreshModels(row.id);
    expect(mgrGood.listModels(row.id).length).toBe(1);

    const badFetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(401, { error: 'bad key' }));
    const mgrBad = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: badFetch });
    const res = await mgrBad.refreshModels(row.id);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain('Authentication failed');
    }
    // Cached models preserved.
    expect(mgrGood.listModels(row.id).length).toBe(1);
    const after = mgrGood.getEndpoint(row.id);
    expect(after?.lastStatus).toBe('error');
  });

  it('handles network errors without throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const mgr = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    const res = await mgr.refreshModels(row.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('ECONNREFUSED');
    expect(mgr.getEndpoint(row.id)?.lastStatus).toBe('error');
  });
});

describe('EndpointsManager: testConnection', () => {
  beforeEach(() => freshDb());

  it('returns ok on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, anthropicPage([])));
    const mgr = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    const res = await mgr.testConnection({ baseUrl: 'https://a', apiKey: 'sk' });
    expect(res.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://a/v1/models?limit=1');
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-api-key']).toBe('sk');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('surfaces HTTP 401 as structured error without writing DB', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(401, { error: 'nope' }));
    const mgr = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    const res = await mgr.testConnection({ baseUrl: 'https://a', apiKey: 'wrong' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain('Authentication failed');
    }
  });
});

describe('buildModelsUrl', () => {
  it('strips trailing /v1 from baseUrl', () => {
    expect(__test__.buildModelsUrl('https://a/v1', { limit: 1 })).toBe('https://a/v1/models?limit=1');
  });
  it('strips trailing slash', () => {
    expect(__test__.buildModelsUrl('https://a/', { limit: 1 })).toBe('https://a/v1/models?limit=1');
  });
});
