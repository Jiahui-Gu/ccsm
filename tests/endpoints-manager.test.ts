import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  EndpointsManager,
  type KeyCrypto,
  type ListModelsFn,
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

function makeListModelsOk(
  ids: Array<string | { id: string; displayName?: string }>,
  source: 'init' | 'initialize-rpc' | 'none' = 'init',
): ListModelsFn {
  return vi.fn(async () => ({
    ok: true,
    source,
    models: ids.map((x) => (typeof x === 'string' ? { id: x } : x)),
  }));
}

function makeListModelsErr(error: string): ListModelsFn {
  return vi.fn(async () => ({ ok: false, error }));
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
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

  it('removeEndpoint cascades to endpoint_models and promotes a new default', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModelsOk(['m-1']),
    });
    const a = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', isDefault: true });
    const b = mgr.addEndpoint({ name: 'B', baseUrl: 'https://b' });
    await mgr.refreshModels(a.id);
    expect(mgr.listModels(a.id).length).toBeGreaterThanOrEqual(1);
    mgr.removeEndpoint(a.id);
    expect(mgr.getEndpoint(a.id)).toBeNull();
    expect(mgr.listModels(a.id).length).toBe(0);
    expect(mgr.getEndpoint(b.id)?.isDefault).toBe(true);
  });

  it('does not persist a key when encryption is unavailable', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto(false) });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk-1' });
    expect(mgr.getPlainKey(row.id)).toBeNull();
  });

  it('adds an endpoint with empty apiKey and persists without a stored key', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto() });
    const row = mgr.addEndpoint({
      name: 'Local relay',
      baseUrl: 'http://127.0.0.1:8080',
      apiKey: '',
    });
    expect(row.id).toBeTruthy();
    expect(mgr.getPlainKey(row.id)).toBeNull();
    const list = mgr.listEndpoints();
    expect(list.find((e) => e.id === row.id)?.name).toBe('Local relay');
  });
});

describe('EndpointsManager: refreshModels via claude.exe', () => {
  beforeEach(() => freshDb());

  it('writes every model claude.exe reports, tagged listed', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModelsOk(
        [{ id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' }, 'claude-opus-4-5'],
        'init',
      ),
    });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    const res = await mgr.refreshModels(row.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.count).toBe(2);
      expect(res.sourceStats.listed).toBe(2);
      expect(res.sourceStats.fallback).toBe(0);
    }
    const ids = mgr.listModels(row.id).map((m) => m.modelId).sort();
    expect(ids).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);
    const sonnet = mgr.listModels(row.id).find((m) => m.modelId === 'claude-sonnet-4-5');
    expect(sonnet?.displayName).toBe('Sonnet 4.5');
    expect(sonnet?.source).toBe('listed');
    expect(sonnet?.existsConfirmed).toBe(true);
  });

  it('falls back to DEFAULT_MODELS when claude.exe answers with empty list', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModelsOk([], 'none'),
    });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    const res = await mgr.refreshModels(row.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.count).toBe(3);
      expect(res.sourceStats.fallback).toBe(3);
      expect(res.sourceStats.listed).toBe(0);
    }
    const rows = mgr.listModels(row.id);
    expect(rows.every((m) => m.source === 'fallback')).toBe(true);
    expect(rows.every((m) => m.existsConfirmed === false)).toBe(true);
  });

  it('merges manualModelIds in alongside listed entries', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModelsOk(['claude-sonnet-4-5'], 'init'),
    });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    mgr.setManualModelIds(row.id, ['custom-model-x', 'claude-sonnet-4-5']);
    const res = await mgr.refreshModels(row.id);
    expect(res.ok).toBe(true);
    const rows = mgr.listModels(row.id);
    const ids = rows.map((m) => m.modelId).sort();
    expect(ids).toContain('custom-model-x');
    expect(ids).toContain('claude-sonnet-4-5');
    const custom = rows.find((m) => m.modelId === 'custom-model-x');
    expect(custom?.source).toBe('manual');
    expect(custom?.existsConfirmed).toBe(false);
    // Overlap: claude-sonnet-4-5 is both listed and manual; listed wins.
    const sonnet = rows.find((m) => m.modelId === 'claude-sonnet-4-5');
    expect(sonnet?.source).toBe('listed');
    expect(sonnet?.existsConfirmed).toBe(true);
  });

  it('marks endpoint error when claude.exe spawn fails', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModelsErr('spawn failed: ENOENT'),
    });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    const res = await mgr.refreshModels(row.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('spawn failed');
    const after = mgr.getEndpoint(row.id);
    expect(after?.lastStatus).toBe('error');
  });

  it('passes the binary path from getBinaryPath into the lister', async () => {
    const lister = makeListModelsOk(['m-1']);
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: lister,
      getBinaryPath: () => '/custom/claude.exe',
    });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    await mgr.refreshModels(row.id);
    expect(lister).toHaveBeenCalledWith({
      baseUrl: 'https://a',
      apiKey: 'sk',
      binPath: '/custom/claude.exe',
    });
  });
});

describe('EndpointsManager: testConnection', () => {
  beforeEach(() => freshDb());

  it('returns ok on 200 from /v1/models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { data: [] }));
    const mgr = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    const res = await mgr.testConnection({ baseUrl: 'https://a', apiKey: 'sk' });
    expect(res.ok).toBe(true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://a/v1/models?limit=1');
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-api-key']).toBe('sk');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('surfaces HTTP 401 as structured error without spawning claude', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(401, { error: 'nope' }));
    const lister = makeListModelsOk(['x']);
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      fetchImpl: fetchMock,
      listModels: lister,
    });
    const res = await mgr.testConnection({ baseUrl: 'https://a', apiKey: 'wrong' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain('Authentication failed');
    }
    expect(lister).not.toHaveBeenCalled();
  });

  it('falls through to claude.exe spawn when /v1/models 404s', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(404, { error: 'no' }));
    const lister = makeListModelsOk(['m-1']);
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      fetchImpl: fetchMock,
      listModels: lister,
    });
    const res = await mgr.testConnection({ baseUrl: 'https://relay', apiKey: 'sk' });
    expect(res.ok).toBe(true);
    expect(lister).toHaveBeenCalled();
  });

  it('reports failure if both /v1/models and claude.exe spawn fail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(500, { error: 'oops' }));
    const lister = makeListModelsErr('spawn timeout');
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      fetchImpl: fetchMock,
      listModels: lister,
    });
    const res = await mgr.testConnection({ baseUrl: 'https://relay', apiKey: 'sk' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('spawn timeout');
  });

  it('succeeds with an empty apiKey and omits the x-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { data: [] }));
    const mgr = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    const res = await mgr.testConnection({ baseUrl: 'https://relay.local', apiKey: '' });
    expect(res.ok).toBe(true);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['x-api-key']).toBeUndefined();
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('empty-key + 401 surfaces a "requires a key" hint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(401, { error: 'need key' }));
    const mgr = new EndpointsManager({ crypto: makeCrypto(), fetchImpl: fetchMock });
    const res = await mgr.testConnection({ baseUrl: 'https://a', apiKey: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toContain('requires a key');
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
