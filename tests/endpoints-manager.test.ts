import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  EndpointsManager,
  type KeyCrypto,
  type ListModelsFn,
  __test__,
} from '../electron/endpoints-manager';
import type { ModelSource } from '../electron/agent/list-models-from-settings';
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

/**
 * Build a stub `ListModelsFn`. Each entry is either a bare id (defaults to
 * source='settings', which the manager maps onto 'listed') or a {id, source}
 * tuple to exercise the source-mapping path explicitly.
 */
function makeListModels(
  entries: Array<string | { id: string; source: ModelSource }>,
): ListModelsFn {
  return vi.fn(async () => ({
    ok: true,
    models: entries.map((x) =>
      typeof x === 'string' ? { id: x, source: 'settings' as ModelSource } : x,
    ),
  }));
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

  // CRUD-focused tests don't care about discovery; addEndpoint / updateEndpoint
  // / setManualModelIds now schedule a background refresh, so we inject a
  // no-op lister to keep the in-flight promise from racing against the next
  // test's fresh db. The auto-refresh behaviour itself is exercised in its
  // own describe block below.
  const NOOP_LISTER: ListModelsFn = makeListModels([]);

  it('adds an endpoint and stores the key encrypted', () => {
    const crypto = makeCrypto();
    const mgr = new EndpointsManager({ crypto, listModels: NOOP_LISTER });
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
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: NOOP_LISTER });
    mgr.addEndpoint({ name: 'A', baseUrl: 'https://a' });
    mgr.addEndpoint({ name: 'B', baseUrl: 'https://b', isDefault: true });
    const list = mgr.listEndpoints();
    expect(list[0].name).toBe('B');
    expect(list[0].isDefault).toBe(true);
    expect(list[1].isDefault).toBe(false);
  });

  it('setting a new default unsets the previous one', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: NOOP_LISTER });
    const a = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', isDefault: true });
    const b = mgr.addEndpoint({ name: 'B', baseUrl: 'https://b', isDefault: true });
    const after = mgr.listEndpoints();
    expect(after.find((x) => x.id === a.id)?.isDefault).toBe(false);
    expect(after.find((x) => x.id === b.id)?.isDefault).toBe(true);
  });

  it('updateEndpoint with apiKey=null clears the key', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: NOOP_LISTER });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk-1' });
    expect(mgr.getPlainKey(row.id)).toBe('sk-1');
    mgr.updateEndpoint(row.id, { apiKey: null });
    expect(mgr.getPlainKey(row.id)).toBeNull();
  });

  it('removeEndpoint cascades to endpoint_models and promotes a new default', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModels(['m-1']),
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
    const mgr = new EndpointsManager({ crypto: makeCrypto(false), listModels: NOOP_LISTER });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk-1' });
    expect(mgr.getPlainKey(row.id)).toBeNull();
  });

  it('adds an endpoint with empty apiKey and persists without a stored key', () => {
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: NOOP_LISTER });
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

describe('EndpointsManager: auto-refresh on mutation', () => {
  beforeEach(() => freshDb());

  it('addEndpoint triggers a background refreshModels', async () => {
    const lister = makeListModels(['m-1']);
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: lister });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a' });
    expect(row.id).toBeTruthy();
    // The refresh fires microtask-asynchronously; wait until the lister
    // observes the call before asserting.
    await vi.waitFor(() => expect(lister).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(mgr.listModels(row.id).map((m) => m.modelId)).toContain('m-1'),
    );
  });

  it('updateEndpoint triggers a background refreshModels', async () => {
    const lister = makeListModels(['m-1']);
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: lister });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a' });
    await vi.waitFor(() => expect(lister).toHaveBeenCalledTimes(1));
    mgr.updateEndpoint(row.id, { name: 'A2' });
    await vi.waitFor(() => expect(lister).toHaveBeenCalledTimes(2));
  });

  it('setManualModelIds triggers a background refreshModels with the new ids', async () => {
    const lister = makeListModels([
      { id: 'custom-x', source: 'manual' },
    ]);
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: lister });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a' });
    await vi.waitFor(() => expect(lister).toHaveBeenCalledTimes(1));
    mgr.setManualModelIds(row.id, ['custom-x']);
    await vi.waitFor(() => expect(lister).toHaveBeenCalledTimes(2));
    expect(lister).toHaveBeenLastCalledWith({ manualModelIds: ['custom-x'] });
  });
});

describe('EndpointsManager: refreshModels via settings discovery', () => {
  beforeEach(() => freshDb());

  it('persists every model the lister reports, with mapped sources', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModels([
        { id: 'claude-sonnet-4-6', source: 'settings' },
        { id: 'claude-opus-4-7', source: 'env' },
        { id: 'fallback-x', source: 'fallback' },
      ]),
    });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    const res = await mgr.refreshModels(row.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.count).toBe(3);
      expect(res.sourceStats.listed).toBe(2); // settings + env collapse onto 'listed'
      expect(res.sourceStats.fallback).toBe(1);
    }
    const ids = mgr.listModels(row.id).map((m) => m.modelId).sort();
    expect(ids).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6', 'fallback-x']);
    const sonnet = mgr.listModels(row.id).find((m) => m.modelId === 'claude-sonnet-4-6');
    expect(sonnet?.source).toBe('listed');
    expect(sonnet?.existsConfirmed).toBe(true);
    const fallback = mgr.listModels(row.id).find((m) => m.modelId === 'fallback-x');
    expect(fallback?.source).toBe('fallback');
    expect(fallback?.existsConfirmed).toBe(false);
  });

  it('persists fallback-only result when nothing else is configured', async () => {
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      listModels: makeListModels([
        { id: 'claude-opus-4-7', source: 'fallback' },
        { id: 'claude-sonnet-4-6', source: 'fallback' },
        { id: 'claude-haiku-4-5', source: 'fallback' },
      ]),
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

  it('passes manualModelIds from the endpoint into the lister', async () => {
    const lister = makeListModels([
      { id: 'custom-model-x', source: 'manual' },
      { id: 'claude-sonnet-4-6', source: 'settings' },
    ]);
    const mgr = new EndpointsManager({ crypto: makeCrypto(), listModels: lister });
    const row = mgr.addEndpoint({ name: 'A', baseUrl: 'https://a', apiKey: 'sk' });
    mgr.setManualModelIds(row.id, ['custom-model-x', 'claude-sonnet-4-6']);
    await mgr.refreshModels(row.id);
    expect(lister).toHaveBeenCalledWith({
      manualModelIds: ['custom-model-x', 'claude-sonnet-4-6'],
    });
    const custom = mgr.listModels(row.id).find((m) => m.modelId === 'custom-model-x');
    expect(custom?.source).toBe('manual');
    expect(custom?.existsConfirmed).toBe(false);
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

  it('surfaces HTTP 401 as structured error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(401, { error: 'nope' }));
    const lister = makeListModels(['x']);
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

  it('treats /v1/models 404 as reachable (most relays do not expose the catalogue)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(404, { error: 'no' }));
    const lister = makeListModels(['m-1']);
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      fetchImpl: fetchMock,
      listModels: lister,
    });
    const res = await mgr.testConnection({ baseUrl: 'https://relay', apiKey: 'sk' });
    expect(res.ok).toBe(true);
    // Discovery is purely local now — testConnection must not invoke it.
    expect(lister).not.toHaveBeenCalled();
  });

  it('reports failure on 5xx from /v1/models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(500, { error: 'oops' }));
    const mgr = new EndpointsManager({
      crypto: makeCrypto(),
      fetchImpl: fetchMock,
    });
    const res = await mgr.testConnection({ baseUrl: 'https://relay', apiKey: 'sk' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(500);
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
