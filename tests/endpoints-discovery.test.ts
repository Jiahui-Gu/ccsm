import { describe, it, expect, vi } from 'vitest';
import {
  DiscoveryPipeline,
  __test__,
  type DiscoverySource,
} from '../electron/endpoints-discovery';

const { interpretErrorBody, detectKind, shouldTryOllama, mapConcurrent } = __test__;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

interface RouteMap {
  messages?: (modelId: string) => Response | Promise<Response>;
  modelsGet?: () => Response | Promise<Response>;
  tags?: () => Response | Promise<Response>;
}

/**
 * Routes by URL + method so a single `DiscoveryPipeline.discover()` call can
 * fan out to multiple mocks. The tests care about outcomes, not exact URLs.
 */
function routerFetch(routes: RouteMap): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && /\/v1\/messages$/.test(url)) {
      let modelId = '';
      try {
        const parsed = init?.body ? JSON.parse(init.body) : {};
        modelId = parsed.model ?? '';
      } catch {
        /* noop */
      }
      if (routes.messages) return routes.messages(modelId);
      return fakeResponse(404, {
        error: { type: 'not_found_error', message: 'model not found' },
      });
    }
    if (method === 'GET' && /\/v1\/models/.test(url)) {
      if (routes.modelsGet) return routes.modelsGet();
      return fakeResponse(503, 'no mock');
    }
    if (method === 'GET' && /\/api\/tags$/.test(url)) {
      if (routes.tags) return routes.tags();
      return fakeResponse(503, 'no mock');
    }
    return fakeResponse(503, 'no mock');
  });
}

describe('probe verdict parsing', () => {
  it('404 => missing', () => {
    expect(interpretErrorBody(404, '').kind).toBe('missing');
  });
  it('400 with model_not_found body => missing', () => {
    expect(
      interpretErrorBody(400, JSON.stringify({ error: { type: 'not_found_error', message: 'Model not found' } }))
        .kind
    ).toBe('missing');
  });
  it('400 with generic invalid_request_error => exists (model was accepted, other field was bad)', () => {
    expect(
      interpretErrorBody(400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens is required' } }))
        .kind
    ).toBe('exists');
  });
});

describe('endpoint kind detection', () => {
  it('detects anthropic by hostname', () => {
    expect(detectKind('https://api.anthropic.com')).toBe('anthropic');
  });
  it('detects ollama via port 11434', () => {
    expect(detectKind('http://localhost:11434')).toBe('ollama');
    expect(detectKind('http://127.0.0.1:11434')).toBe('ollama');
  });
  it('falls back to unknown for arbitrary relays', () => {
    expect(detectKind('https://relay.example.com')).toBe('unknown');
  });
  it('respects user hint over autodetect', () => {
    expect(detectKind('https://relay.example.com', 'openai-compat')).toBe('openai-compat');
  });
  it('shouldTryOllama covers localhost and :11434', () => {
    expect(shouldTryOllama('unknown', 'http://localhost:8080')).toBe(true);
    expect(shouldTryOllama('unknown', 'http://10.0.0.5:11434')).toBe(true);
    expect(shouldTryOllama('ollama', 'http://anywhere.com')).toBe(true);
    expect(shouldTryOllama('anthropic', 'https://api.anthropic.com')).toBe(false);
  });
});

describe('DiscoveryPipeline.discover — probe tier', () => {
  it('marks existing models when the server returns 200', async () => {
    const fetchImpl = routerFetch({
      messages: (modelId) => {
        if (modelId === 'claude-opus-4-5' || modelId === 'claude-sonnet-4-5') return fakeResponse(200, {});
        return fakeResponse(404, { error: { type: 'not_found_error', message: 'model not found' } });
      },
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk',
      kind: 'anthropic',
    });
    expect(result.ok).toBe(true);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain('claude-opus-4-5');
    expect(ids).toContain('claude-sonnet-4-5');
    const confirmed = result.models.filter((m) => m.existsConfirmed);
    expect(confirmed.length).toBe(2);
  });

  it('does not mark 404s as existing', async () => {
    const fetchImpl = routerFetch({
      messages: () =>
        fakeResponse(404, { error: { type: 'not_found_error', message: 'no such model' } }),
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk',
      kind: 'anthropic',
    });
    expect(result.ok).toBe(true);
    // Everything 404'd → no probe-confirmed models.
    expect(result.models.filter((m) => m.sources.includes('probe'))).toHaveLength(0);
  });

  it('retries with Authorization Bearer after x-api-key 401s on unknown kind', async () => {
    let xApiKeyCalls = 0;
    let bearerCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (init?.method === 'POST' && /\/v1\/messages$/.test(url)) {
        const headers = init.headers ?? {};
        if (headers['x-api-key']) {
          xApiKeyCalls++;
          return fakeResponse(401, { error: 'bad header' });
        }
        if (headers.authorization) {
          bearerCalls++;
          return fakeResponse(200, {});
        }
      }
      return fakeResponse(503, 'no route');
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0, concurrency: 5 });
    const result = await pipeline.discover({
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk',
      kind: 'unknown',
    });
    expect(result.ok).toBe(true);
    expect(xApiKeyCalls).toBeGreaterThan(0);
    expect(bearerCalls).toBeGreaterThan(0);
    // Some model should have been confirmed via bearer retry.
    expect(result.models.some((m) => m.existsConfirmed && m.sources.includes('probe'))).toBe(true);
  });
});

describe('DiscoveryPipeline.discover — introspection + merge', () => {
  it('merges results from /v1/models list AND /v1/messages probe, dedup by id', async () => {
    const fetchImpl = routerFetch({
      modelsGet: () =>
        fakeResponse(200, {
          data: [{ id: 'claude-opus-4-5', display_name: 'Opus 4.5' }, { id: 'claude-rare-1' }],
          has_more: false,
          last_id: 'claude-rare-1',
        }),
      messages: (modelId) => {
        if (modelId === 'claude-opus-4-5' || modelId === 'claude-sonnet-4-5') return fakeResponse(200, {});
        return fakeResponse(404, { error: { type: 'not_found_error', message: 'no' } });
      },
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk',
      kind: 'anthropic',
    });
    expect(result.ok).toBe(true);
    // claude-opus-4-5 came from both -> sources should include both, still single row.
    const opus = result.models.find((m) => m.id === 'claude-opus-4-5');
    expect(opus).toBeTruthy();
    expect(opus!.sources).toEqual(expect.arrayContaining(['listed', 'probe']));
    expect(opus!.displayName).toBe('Opus 4.5');
    // claude-rare-1 only from listing
    const rare = result.models.find((m) => m.id === 'claude-rare-1');
    expect(rare!.sources).toEqual(['listed']);
    // Merged models should include each id exactly once.
    const ids = result.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('manual IDs flow into probe candidates and surface with source=manual when unconfirmed', async () => {
    const fetchImpl = routerFetch({
      messages: () =>
        fakeResponse(404, { error: { type: 'not_found_error', message: 'x' } }),
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk',
      kind: 'anthropic',
      manualModelIds: ['my-private-model'],
    });
    expect(result.ok).toBe(true);
    const manual = result.models.find((m) => m.id === 'my-private-model');
    expect(manual).toBeTruthy();
    expect(manual!.existsConfirmed).toBe(false);
    expect(manual!.sources).toContain('manual');
    expect(result.sourceStats.manual).toBeGreaterThan(0);
  });

  it('manual ID confirmed by probe merges both sources', async () => {
    const fetchImpl = routerFetch({
      messages: (modelId) => (modelId === 'my-model' ? fakeResponse(200, {}) : fakeResponse(404, {})),
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk',
      kind: 'anthropic',
      manualModelIds: ['my-model'],
    });
    expect(result.ok).toBe(true);
    const mine = result.models.find((m) => m.id === 'my-model')!;
    expect(mine.existsConfirmed).toBe(true);
    expect(mine.sources.sort()).toEqual(['manual', 'probe'].sort() as DiscoverySource[]);
  });

  it('Ollama endpoint discovery via /api/tags', async () => {
    const fetchImpl = routerFetch({
      tags: () =>
        fakeResponse(200, {
          models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5' }],
        }),
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'http://localhost:11434',
      apiKey: '',
    });
    expect(result.ok).toBe(true);
    expect(result.detectedKind).toBe('ollama');
    expect(result.models.some((m) => m.id === 'llama3.2:latest')).toBe(true);
  });
});

describe('DiscoveryPipeline.discover — auth failure abort', () => {
  it('returns ok:false with status 401 when every branch reports auth failure', async () => {
    const fetchImpl = routerFetch({
      messages: () => fakeResponse(401, { error: { type: 'authentication_error' } }),
      modelsGet: () => fakeResponse(401, { error: 'bad key' }),
    });
    const pipeline = new DiscoveryPipeline({ fetchImpl, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'bad',
      kind: 'anthropic',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error?.toLowerCase()).toContain('auth');
  });
});

describe('mapConcurrent semaphore', () => {
  it('never exceeds the concurrency cap', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inflight = 0;
    let peak = 0;
    const results = await mapConcurrent(items, 5, async (x) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return x * 2;
    });
    expect(results).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(5);
    // Sanity: we actually exercised parallelism.
    expect(peak).toBeGreaterThan(1);
  });
});

describe('Bedrock / Vertex kinds are not supported yet', () => {
  it('returns ok:false with a clear message rather than probing', async () => {
    const fetchImpl = vi.fn();
    const pipeline = new DiscoveryPipeline({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 0 });
    const result = await pipeline.discover({
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      apiKey: '',
      kind: 'bedrock',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not supported');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
