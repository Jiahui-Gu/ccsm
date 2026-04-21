/**
 * Tiered model discovery pipeline.
 *
 * Real-world `baseUrl` targets fall into several incompatible buckets:
 *   - Anthropic's canonical API — speaks `/v1/models` and `/v1/messages`.
 *   - Self-hosted relays / 中转 — only forward `/v1/messages` (no catalogue).
 *   - OpenAI-compat shims (Kimi/DeepSeek/LiteLLM) — `Authorization: Bearer` on
 *     `/v1/models`; may or may not also accept Anthropic headers.
 *   - Ollama / LM Studio — `/api/tags` with no auth.
 *
 * A single GET /v1/models call (the old behavior) therefore fails on the
 * majority of endpoints users actually plug in. The pipeline below queries
 * several disjoint signals in parallel and unions the results, letting the UI
 * degrade gracefully (the user can always curate manually).
 *
 * Cost budget: ~3s wall-time, <=30 candidate probes with concurrency 5.
 */

import { randomUUID } from 'node:crypto';

export type FetchLike = typeof fetch;

export type EndpointKind =
  | 'anthropic'
  | 'openai-compat'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'unknown';

export type DiscoverySource = 'probe' | 'listed' | 'manual';

export interface DiscoveredModel {
  id: string;
  /**
   * `true` only when a concrete probe/list call confirmed the model exists at
   * this endpoint. Manual IDs that no probe confirmed are surfaced with
   * `existsConfirmed: false` so the UI can tag them "unverified".
   */
  existsConfirmed: boolean;
  sources: DiscoverySource[];
  displayName?: string;
}

export interface DiscoveryResult {
  ok: boolean;
  /** 'auth' aborts discovery early (401 on any branch with a concrete key). */
  error?: string;
  status?: number;
  detectedKind: EndpointKind;
  models: DiscoveredModel[];
  sourceStats: Record<DiscoverySource, number>;
}

export interface DiscoverArgs {
  baseUrl: string;
  apiKey: string;
  kind?: EndpointKind;
  /** IDs from a previous successful refresh — included in probe candidates. */
  knownModelIds?: string[];
  /** IDs the user typed in the "Manual model IDs" box. */
  manualModelIds?: string[];
}

export interface DiscoveryDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Overridable probe concurrency for tests. */
  concurrency?: number;
  /** Per-request timeout (ms). 0 = no timeout (tests). */
  timeoutMs?: number;
}

// ---------- Hardcoded probe candidates by kind ----------
//
// Keep these lists tight: the probe budget is 30 candidates total across the
// merge of hardcoded + known + manual. Prefer recent + still-current IDs; do
// NOT pad with long-deprecated names just to be comprehensive.

const ANTHROPIC_CANDIDATES: string[] = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-opus-4-1-20250805',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
];

const OPENAI_CANDIDATES: string[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'o3',
  'o4-mini',
];

const OLLAMA_CANDIDATES: string[] = [
  'llama3.2',
  'llama3.1',
  'qwen2.5',
  'deepseek-r1',
];

function candidatesForKind(kind: EndpointKind): string[] {
  switch (kind) {
    case 'anthropic':
      return ANTHROPIC_CANDIDATES;
    case 'openai-compat':
      return OPENAI_CANDIDATES;
    case 'ollama':
      return OLLAMA_CANDIDATES;
    case 'bedrock':
    case 'vertex':
      return []; // Not supported in this PR.
    case 'unknown':
    default:
      // For truly unknown endpoints (most 中转 relays) bias toward Anthropic
      // first since the probe hits `/v1/messages` which is the Anthropic API.
      return [...ANTHROPIC_CANDIDATES, ...OPENAI_CANDIDATES];
  }
}

const MAX_PROBE_CANDIDATES = 30;

// ---------- Base URL helpers ----------

export function normaliseBaseUrl(baseUrl: string): string {
  let u = baseUrl.trim();
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/v1$/i, '');
  return u;
}

/**
 * Best-effort URL parsing. Non-URL inputs get a harmless stub so detection
 * still runs and yields `unknown`.
 */
function safeParseUrl(baseUrl: string): URL | null {
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
}

/**
 * Cheap sniff for endpoint kind. Never blocks discovery: `unknown` is a valid
 * outcome and the pipeline fans out to all tiers in that case.
 */
export function detectKind(baseUrl: string, hinted?: EndpointKind): EndpointKind {
  if (hinted && hinted !== 'unknown') return hinted;
  const url = safeParseUrl(baseUrl);
  if (!url) return 'unknown';
  const host = url.hostname.toLowerCase();
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    // Ollama default :11434; LM Studio :1234. Bias to ollama for the common
    // case; unknown paths just mean the probe tier also runs.
    if (url.port === '11434') return 'ollama';
  }
  if (url.port === '11434') return 'ollama';
  if (/bedrock/.test(host)) return 'bedrock';
  if (/aiplatform\.googleapis\.com$/.test(host)) return 'vertex';
  if (/openai\.com$/.test(host)) return 'openai-compat';
  return 'unknown';
}

// ---------- Fetch plumbing ----------

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  timeoutMs: number
): Promise<Response> {
  if (timeoutMs <= 0) return fetchImpl(url, init);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Merge: allow callers to pass their own signal but default to the timeout.
    const merged = { ...(init ?? {}), signal: init?.signal ?? ac.signal };
    return await fetchImpl(url, merged);
  } finally {
    clearTimeout(t);
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 512);
  } catch {
    return '';
  }
}

function describeHttpError(status: number, body: string): string {
  if (status === 401 || status === 403) return `Authentication failed (HTTP ${status})`;
  if (status === 404) return `Not found (HTTP 404)`;
  if (status === 429) return `Rate limited (HTTP 429)`;
  if (status >= 500) return `Upstream error (HTTP ${status})`;
  return body ? `HTTP ${status}: ${body}` : `HTTP ${status}`;
}

// ---------- Tier 1: probe /v1/messages ----------

type ProbeVerdict =
  | { kind: 'exists' }
  | { kind: 'missing' }
  | { kind: 'auth' }
  | { kind: 'unknown' };

/**
 * Parse the JSON error body Anthropic (and most proxies) return on 4xx to
 * distinguish "model doesn't exist" from "request was malformed in some other
 * way". A 400 with `invalid_request_error` that DOESN'T mention the model is
 * still an existence signal — if the server had to look up the model to reject
 * our request, the model exists.
 */
function interpretErrorBody(status: number, body: string): ProbeVerdict {
  const lower = body.toLowerCase();
  const mentionsModel =
    lower.includes('model') &&
    (lower.includes('not found') ||
      lower.includes('not_found') ||
      lower.includes('unknown') ||
      lower.includes('does not exist') ||
      lower.includes('invalid model') ||
      lower.includes("doesn't exist"));
  if (status === 404 || mentionsModel) return { kind: 'missing' };
  if (status === 400) {
    // 400 with no model-specific complaint => the server accepted the model id
    // and is complaining about something else (max_tokens, content shape, …).
    return { kind: 'exists' };
  }
  return { kind: 'unknown' };
}

function buildProbeBody(modelId: string): string {
  return JSON.stringify({
    model: modelId,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'x' }],
  });
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

function bearerHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

interface ProbeContext {
  fetchImpl: FetchLike;
  baseUrl: string;
  apiKey: string;
  kind: EndpointKind;
  timeoutMs: number;
  /**
   * Shared mutable flag: once any probe returns 401 we stop kicking off new
   * auth-attempts. Doesn't cancel in-flight ones (acceptable — they're cheap).
   */
  authFailed: { value: boolean };
}

async function probeOnce(
  ctx: ProbeContext,
  modelId: string,
  attempt = 0
): Promise<ProbeVerdict> {
  if (ctx.authFailed.value) return { kind: 'auth' };
  const url = `${normaliseBaseUrl(ctx.baseUrl)}/v1/messages`;
  const useBearerFirst = ctx.kind === 'openai-compat';
  const headerOrder: Array<(k: string) => Record<string, string>> =
    ctx.kind === 'anthropic'
      ? [anthropicHeaders]
      : useBearerFirst
      ? [bearerHeaders, anthropicHeaders]
      : [anthropicHeaders, bearerHeaders];

  let lastVerdict: ProbeVerdict = { kind: 'unknown' };
  let sawAuth = false;
  for (const buildHeaders of headerOrder) {
    try {
      const res = await fetchWithTimeout(
        ctx.fetchImpl,
        url,
        {
          method: 'POST',
          headers: buildHeaders(ctx.apiKey),
          body: buildProbeBody(modelId),
        },
        ctx.timeoutMs
      );
      if (res.status === 200) return { kind: 'exists' };
      if (res.status === 401 || res.status === 403) {
        // Try the next header variant before declaring auth dead.
        sawAuth = true;
        lastVerdict = { kind: 'auth' };
        continue;
      }
      if (res.status === 429 && attempt < 2) {
        const backoff = attempt === 0 ? 250 : 750;
        await new Promise((r) => setTimeout(r, backoff));
        return probeOnce(ctx, modelId, attempt + 1);
      }
      const body = await safeReadText(res);
      const verdict = interpretErrorBody(res.status, body);
      if (verdict.kind !== 'unknown') return verdict;
      lastVerdict = verdict;
    } catch {
      // Network / abort — don't blame the model, just move on.
      lastVerdict = { kind: 'unknown' };
    }
  }
  // Surface that every header variant auth'd out so the caller can bail.
  if (sawAuth && lastVerdict.kind === 'auth') {
    ctx.authFailed.value = true;
  }
  return lastVerdict;
}

/**
 * Bounded-concurrency map. Kept tiny so we don't add p-limit for one site.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  let inflight = 0;
  let peakInflight = 0;
  return new Promise<R[]>((resolve, reject) => {
    if (items.length === 0) return resolve(results);
    const pump = (): void => {
      while (inflight < limit && i < items.length) {
        const idx = i++;
        inflight++;
        peakInflight = Math.max(peakInflight, inflight);
        fn(items[idx]).then(
          (r) => {
            results[idx] = r;
            inflight--;
            if (i >= items.length && inflight === 0) {
              (results as unknown as { peakInflight?: number }).peakInflight = peakInflight;
              resolve(results);
            } else {
              pump();
            }
          },
          (err) => reject(err)
        );
      }
    };
    pump();
  });
}

async function tierProbe(
  ctx: ProbeContext,
  candidates: string[],
  concurrency: number
): Promise<{ models: DiscoveredModel[]; authFailed: boolean }> {
  const verdicts = await mapConcurrent(candidates, concurrency, (id) => probeOnce(ctx, id));
  const models: DiscoveredModel[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const v = verdicts[i];
    if (v.kind === 'exists') {
      models.push({ id: candidates[i], existsConfirmed: true, sources: ['probe'] });
    }
  }
  return { models, authFailed: ctx.authFailed.value };
}

// ---------- Tier 2: introspection ----------

interface AnthropicModelsPage {
  data: Array<{ id: string; display_name?: string }>;
  has_more: boolean;
  first_id?: string | null;
  last_id?: string | null;
}

interface OpenAiModelsPage {
  data: Array<{ id: string }>;
}

interface OllamaTagsPage {
  models: Array<{ name?: string; model?: string }>;
}

async function tryAnthropicModelsList(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number
): Promise<DiscoveredModel[] | null> {
  const base = normaliseBaseUrl(baseUrl);
  const collected: Array<{ id: string; display_name?: string }> = [];
  let afterId: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams();
    params.set('limit', '100');
    if (afterId) params.set('after_id', afterId);
    const url = `${base}/v1/models?${params.toString()}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        url,
        { method: 'GET', headers: anthropicHeaders(apiKey) },
        timeoutMs
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let payload: AnthropicModelsPage;
    try {
      payload = (await res.json()) as AnthropicModelsPage;
    } catch {
      return null;
    }
    if (!payload || !Array.isArray(payload.data)) return null;
    collected.push(...payload.data);
    if (!payload.has_more) break;
    afterId = payload.last_id ?? payload.data[payload.data.length - 1]?.id;
    if (!afterId) break;
  }
  return collected.map((m) => ({
    id: m.id,
    existsConfirmed: true,
    sources: ['listed'],
    displayName: m.display_name,
  }));
}

async function tryOpenAiModelsList(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number
): Promise<DiscoveredModel[] | null> {
  const base = normaliseBaseUrl(baseUrl);
  const url = `${base}/v1/models`;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'GET', headers: bearerHeaders(apiKey) },
      timeoutMs
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let payload: OpenAiModelsPage;
  try {
    payload = (await res.json()) as OpenAiModelsPage;
  } catch {
    return null;
  }
  if (!payload || !Array.isArray(payload.data)) return null;
  return payload.data
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({ id: m.id, existsConfirmed: true, sources: ['listed'] as DiscoverySource[] }));
}

async function tryOllamaTags(
  fetchImpl: FetchLike,
  baseUrl: string,
  timeoutMs: number
): Promise<DiscoveredModel[] | null> {
  const base = normaliseBaseUrl(baseUrl);
  // Ollama's tags endpoint lives at `/api/tags`, not under `/v1`.
  const url = `${base}/api/tags`;
  let res: Response;
  try {
    res = await fetchWithTimeout(fetchImpl, url, { method: 'GET' }, timeoutMs);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let payload: OllamaTagsPage;
  try {
    payload = (await res.json()) as OllamaTagsPage;
  } catch {
    return null;
  }
  if (!payload || !Array.isArray(payload.models)) return null;
  return payload.models
    .map((m) => m?.name ?? m?.model ?? '')
    .filter((id): id is string => !!id)
    .map((id) => ({ id, existsConfirmed: true, sources: ['listed'] as DiscoverySource[] }));
}

function shouldTryOllama(kind: EndpointKind, baseUrl: string): boolean {
  if (kind === 'ollama') return true;
  const url = safeParseUrl(baseUrl);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (url.port === '11434') return true;
  if (url.pathname.replace(/\/+$/, '').endsWith('/api')) return true;
  return false;
}

// ---------- Pipeline ----------

export class DiscoveryPipeline {
  private readonly fetchImpl: FetchLike;
  private readonly concurrency: number;
  private readonly timeoutMs: number;

  constructor(deps: DiscoveryDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.concurrency = deps.concurrency ?? 5;
    this.timeoutMs = deps.timeoutMs ?? 8000;
  }

  async discover(args: DiscoverArgs): Promise<DiscoveryResult> {
    const detectedKind = detectKind(args.baseUrl, args.kind);

    // Bedrock/Vertex: discovery out-of-scope for this PR. Return an honest
    // "not supported" marker rather than silently running probes that'll 404.
    if (detectedKind === 'bedrock' || detectedKind === 'vertex') {
      return {
        ok: false,
        error: `Discovery not supported for ${detectedKind} endpoints yet`,
        detectedKind,
        models: [],
        sourceStats: { probe: 0, listed: 0, manual: 0 },
      };
    }

    const candidates = this.buildCandidates({
      kind: detectedKind,
      known: args.knownModelIds ?? [],
      manual: args.manualModelIds ?? [],
    });

    const authFailed = { value: false };
    const probeCtx: ProbeContext = {
      fetchImpl: this.fetchImpl,
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      kind: detectedKind,
      timeoutMs: this.timeoutMs,
      authFailed,
    };

    // Fan out T1 + T2 in parallel. `allSettled` so a slow Ollama call can't
    // block the probe branch and vice versa.
    const strategies: Array<Promise<DiscoveredModel[] | null>> = [];

    strategies.push(
      tierProbe(probeCtx, candidates, this.concurrency).then((r) => r.models)
    );

    if (detectedKind === 'anthropic' || detectedKind === 'unknown') {
      strategies.push(
        tryAnthropicModelsList(this.fetchImpl, args.baseUrl, args.apiKey, this.timeoutMs)
      );
    }
    if (detectedKind === 'openai-compat' || detectedKind === 'unknown') {
      strategies.push(
        tryOpenAiModelsList(this.fetchImpl, args.baseUrl, args.apiKey, this.timeoutMs)
      );
    }
    if (shouldTryOllama(detectedKind, args.baseUrl)) {
      strategies.push(tryOllamaTags(this.fetchImpl, args.baseUrl, this.timeoutMs));
    }

    const settled = await Promise.allSettled(strategies);
    const found: DiscoveredModel[] = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled' || !s.value) continue;
      found.push(...s.value);
    }

    // If we confirmed nothing AND every strategy saw only 401s, bail.
    if (found.length === 0 && authFailed.value) {
      return {
        ok: false,
        error: 'Authentication failed — check your API key',
        status: 401,
        detectedKind,
        models: [],
        sourceStats: { probe: 0, listed: 0, manual: 0 },
      };
    }

    // Merge manual IDs in — those not confirmed get existsConfirmed: false.
    const merged = this.mergeResults(found, args.manualModelIds ?? []);

    const sourceStats: Record<DiscoverySource, number> = { probe: 0, listed: 0, manual: 0 };
    for (const m of merged) {
      for (const s of m.sources) sourceStats[s]++;
    }

    return {
      ok: true,
      detectedKind,
      models: merged,
      sourceStats,
    };
  }

  private buildCandidates(args: {
    kind: EndpointKind;
    known: string[];
    manual: string[];
  }): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (id: string | undefined | null): void => {
      if (!id) return;
      const trimmed = id.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push(trimmed);
    };
    // Hardcoded first so the most likely hits land in the first concurrency
    // batch; known/manual follow.
    for (const id of candidatesForKind(args.kind)) push(id);
    for (const id of args.known) push(id);
    for (const id of args.manual) push(id);
    return out.slice(0, MAX_PROBE_CANDIDATES);
  }

  private mergeResults(found: DiscoveredModel[], manual: string[]): DiscoveredModel[] {
    const byId = new Map<string, DiscoveredModel>();
    for (const m of found) {
      const prev = byId.get(m.id);
      if (!prev) {
        byId.set(m.id, { ...m, sources: [...m.sources] });
      } else {
        for (const s of m.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
        if (m.displayName && !prev.displayName) prev.displayName = m.displayName;
        if (m.existsConfirmed) prev.existsConfirmed = true;
      }
    }
    const manualSet = new Set(manual.map((s) => s.trim()).filter(Boolean));
    for (const id of manualSet) {
      const prev = byId.get(id);
      if (prev) {
        if (!prev.sources.includes('manual')) prev.sources.push('manual');
      } else {
        byId.set(id, { id, existsConfirmed: false, sources: ['manual'] });
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  }
}

// Test-only surface.
export const __test__ = {
  interpretErrorBody,
  detectKind,
  shouldTryOllama,
  mapConcurrent,
  candidatesForKind,
  describeHttpError,
  MAX_PROBE_CANDIDATES,
};

export function newDiscoveryId(): string {
  return randomUUID();
}
