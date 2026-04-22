import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { listModelsViaClaude } from './agent/list-models-via-claude';

/**
 * Endpoint "kind" — the user's declared backend type. We keep `detectedKind`
 * as a sibling because the old probe pipeline could *detect* it post-refresh;
 * the new claude.exe-driven discovery doesn't sniff endpoint shape, so
 * `detectedKind` just mirrors `kind` after a successful refresh.
 *
 * Kept as an alias so callers / DB schema / IPC surface don't churn; the
 * only consumer of the `bedrock`/`vertex` arms is the renderer's status chip.
 */
export type EndpointKind =
  | 'anthropic'
  | 'openai-compat'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'unknown';

/**
 * Model row source — `'listed'` is what claude.exe reports back via its
 * init frame / initialize RPC; `'fallback'` is the hardcoded
 * `[sonnet, opus, haiku]` triple; `'manual'` is anything the user typed
 * into the "Manual model IDs" box on the endpoint page.
 *
 * The historical `'probe'` source is gone with the probe pipeline. UI code
 * that switches on this value treats unknown variants as `'listed'`.
 */
export type DiscoverySource = 'listed' | 'fallback' | 'manual';

/**
 * Last-resort model list when claude.exe couldn't tell us anything (e.g. the
 * relay refused the spawn, or it answered but with no models[]). Three Claude
 * 4.5-tier aliases that every Anthropic-compatible endpoint we've shipped to
 * understands. Kept short on purpose: the user can always type more into
 * `manualModelIds`.
 */
export const DEFAULT_MODELS: readonly string[] = [
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-haiku-4-5',
];

export type EndpointStatus = 'ok' | 'error' | 'unchecked';

export interface EndpointRow {
  id: string;
  name: string;
  baseUrl: string;
  kind: EndpointKind;
  isDefault: boolean;
  lastStatus: EndpointStatus;
  lastError: string | null;
  lastRefreshedAt: number | null;
  createdAt: number;
  updatedAt: number;
  detectedKind: EndpointKind | null;
  manualModelIds: string[];
}

export interface ModelRow {
  id: string;
  endpointId: string;
  modelId: string;
  displayName: string | null;
  discoveredAt: number;
  source: DiscoverySource;
  existsConfirmed: boolean;
}

export interface EndpointWithModels extends EndpointRow {
  models: ModelRow[];
}

export interface AddEndpointInput {
  name: string;
  baseUrl: string;
  kind?: EndpointKind;
  apiKey?: string;
  isDefault?: boolean;
}

export interface UpdateEndpointInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null; // null = clear, undefined = leave as-is
  isDefault?: boolean;
  kind?: EndpointKind;
}

export interface KeyCrypto {
  isAvailable: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
}

type FetchLike = typeof fetch;

/**
 * Pluggable model-list fetcher. Production wiring spawns claude.exe via
 * {@link listModelsViaClaude}; tests inject a stub so they never touch the
 * OS. Returning `ok:true` with an empty list is the signal for "endpoint is
 * reachable but had nothing to say" — the caller then merges DEFAULT_MODELS.
 */
export type ListModelsFn = (args: {
  baseUrl: string;
  apiKey: string;
  binPath?: string;
}) => Promise<
  | { ok: true; models: Array<{ id: string; displayName?: string }>; source: 'init' | 'initialize-rpc' | 'none' }
  | { ok: false; error: string }
>;

export interface EndpointsManagerDeps {
  crypto: KeyCrypto;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Override the model lister (tests). Defaults to {@link listModelsViaClaude}. */
  listModels?: ListModelsFn;
  /**
   * Resolve the claude.exe binary path. Returning undefined lets the spawner
   * resolve via PATH. Wired to `loadClaudeBinPath()` in main.ts so a user-set
   * override flows through without dragging that dependency in here.
   */
  getBinaryPath?: () => string | undefined;
}

interface RawEndpoint {
  id: string;
  name: string;
  base_url: string;
  kind: string;
  api_key_encrypted: Buffer | null;
  is_default: number;
  last_status: string | null;
  last_error: string | null;
  last_refreshed_at: number | null;
  created_at: number;
  updated_at: number;
  detected_kind: string | null;
  manual_model_ids: string | null;
}

interface RawModel {
  id: string;
  endpoint_id: string;
  model_id: string;
  display_name: string | null;
  discovered_at: number;
  source: string | null;
  exists_confirmed: number | null;
}

export class EndpointsManager {
  private readonly crypto: KeyCrypto;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly listModelsFn: ListModelsFn;
  private readonly getBinaryPath: () => string | undefined;

  constructor(deps: EndpointsManagerDeps) {
    this.crypto = deps.crypto;
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.now = deps.now ?? (() => Date.now());
    this.listModelsFn = deps.listModels ?? listModelsViaClaude;
    this.getBinaryPath = deps.getBinaryPath ?? (() => undefined);
  }

  // ---------- CRUD ----------

  listEndpoints(): EndpointRow[] {
    const rows = getDb()
      .prepare(
        `SELECT id, name, base_url, kind, api_key_encrypted, is_default,
                last_status, last_error, last_refreshed_at, created_at, updated_at,
                detected_kind, manual_model_ids
         FROM endpoints ORDER BY is_default DESC, created_at ASC`
      )
      .all() as RawEndpoint[];
    return rows.map(toEndpointRow);
  }

  getEndpoint(id: string): EndpointRow | null {
    const row = getDb()
      .prepare(
        `SELECT id, name, base_url, kind, api_key_encrypted, is_default,
                last_status, last_error, last_refreshed_at, created_at, updated_at,
                detected_kind, manual_model_ids
         FROM endpoints WHERE id = ?`
      )
      .get(id) as RawEndpoint | undefined;
    return row ? toEndpointRow(row) : null;
  }

  getPlainKey(id: string): string | null {
    const row = getDb()
      .prepare('SELECT api_key_encrypted FROM endpoints WHERE id = ?')
      .get(id) as { api_key_encrypted: Buffer | null } | undefined;
    if (!row || !row.api_key_encrypted) return null;
    if (!this.crypto.isAvailable()) return null;
    try {
      return this.crypto.decrypt(row.api_key_encrypted);
    } catch {
      return null;
    }
  }

  addEndpoint(input: AddEndpointInput): EndpointRow {
    const id = randomUUID();
    const now = this.now();
    const enc = this.encryptKey(input.apiKey);
    const kind: EndpointKind = input.kind ?? 'anthropic';
    const isDefault = input.isDefault ? 1 : 0;

    const db = getDb();
    const run = db.transaction(() => {
      if (isDefault) {
        db.prepare('UPDATE endpoints SET is_default = 0').run();
      }
      db.prepare(
        `INSERT INTO endpoints (
          id, name, base_url, kind, api_key_encrypted, is_default,
          last_status, last_error, last_refreshed_at, created_at, updated_at,
          detected_kind, manual_model_ids
        ) VALUES (?, ?, ?, ?, ?, ?, 'unchecked', NULL, NULL, ?, ?, NULL, NULL)`
      ).run(id, input.name, input.baseUrl, kind, enc, isDefault, now, now);
    });
    run();

    const row = this.getEndpoint(id);
    if (!row) throw new Error('addEndpoint: insert succeeded but row missing');
    return row;
  }

  updateEndpoint(id: string, patch: UpdateEndpointInput): EndpointRow | null {
    const existing = this.getEndpoint(id);
    if (!existing) return null;
    const now = this.now();
    const name = patch.name ?? existing.name;
    const baseUrl = patch.baseUrl ?? existing.baseUrl;
    const isDefault = patch.isDefault === undefined ? existing.isDefault : patch.isDefault;
    const kind = patch.kind ?? existing.kind;

    let enc: Buffer | null | 'keep' = 'keep';
    if (patch.apiKey === null) enc = null;
    else if (typeof patch.apiKey === 'string') enc = this.encryptKey(patch.apiKey);

    const db = getDb();
    const run = db.transaction(() => {
      if (isDefault && !existing.isDefault) {
        db.prepare('UPDATE endpoints SET is_default = 0').run();
      }
      if (enc === 'keep') {
        db.prepare(
          `UPDATE endpoints SET name = ?, base_url = ?, kind = ?, is_default = ?, updated_at = ?
           WHERE id = ?`
        ).run(name, baseUrl, kind, isDefault ? 1 : 0, now, id);
      } else {
        db.prepare(
          `UPDATE endpoints SET name = ?, base_url = ?, kind = ?, api_key_encrypted = ?, is_default = ?, updated_at = ?
           WHERE id = ?`
        ).run(name, baseUrl, kind, enc, isDefault ? 1 : 0, now, id);
      }
    });
    run();
    return this.getEndpoint(id);
  }

  removeEndpoint(id: string): boolean {
    const db = getDb();
    const target = this.getEndpoint(id);
    if (!target) return false;
    const run = db.transaction(() => {
      db.prepare('DELETE FROM endpoints WHERE id = ?').run(id);
      if (target.isDefault) {
        const next = db
          .prepare('SELECT id FROM endpoints ORDER BY created_at ASC LIMIT 1')
          .get() as { id: string } | undefined;
        if (next) {
          db.prepare('UPDATE endpoints SET is_default = 1, updated_at = ? WHERE id = ?').run(
            this.now(),
            next.id
          );
        }
      }
    });
    run();
    return true;
  }

  setManualModelIds(id: string, ids: string[]): EndpointRow | null {
    const existing = this.getEndpoint(id);
    if (!existing) return null;
    const cleaned = Array.from(
      new Set(ids.map((s) => s.trim()).filter((s) => s.length > 0))
    );
    const encoded = JSON.stringify(cleaned);
    getDb()
      .prepare('UPDATE endpoints SET manual_model_ids = ?, updated_at = ? WHERE id = ?')
      .run(encoded, this.now(), id);
    return this.getEndpoint(id);
  }

  // ---------- Models ----------

  listModels(endpointId: string): ModelRow[] {
    const rows = getDb()
      .prepare(
        `SELECT id, endpoint_id, model_id, display_name, discovered_at, source, exists_confirmed
         FROM endpoint_models WHERE endpoint_id = ? ORDER BY model_id ASC`
      )
      .all(endpointId) as RawModel[];
    return rows.map(toModelRow);
  }

  listModelsAll(): EndpointWithModels[] {
    const endpoints = this.listEndpoints();
    return endpoints.map((e) => ({ ...e, models: this.listModels(e.id) }));
  }

  // ---------- Network: test + refresh ----------

  /**
   * Lightweight connectivity probe. Tries GET /v1/models (cheap, what
   * api.anthropic.com supports). On 404 we fall through to a claude.exe
   * model-list spawn — if claude can talk to the endpoint at all, that's
   * "connected" for our purposes. On 401/403 from the GET we surface
   * structured auth failure without burning a second attempt.
   */
  async testConnection(args: {
    baseUrl: string;
    apiKey: string;
  }): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
    const url = buildModelsUrl(args.baseUrl, { limit: 1 });
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: buildAnthropicHeaders(args.apiKey),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        const body = await safeReadText(res);
        return {
          ok: false,
          status: res.status,
          error: describeHttpError(res.status, body, { hasKey: args.apiKey.length > 0 }),
        };
      }
      // /v1/models not supported (most relays) — fall through to spawn-based.
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const result = await this.listModelsFn({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        binPath: this.getBinaryPath(),
      });
      if (!result.ok) return { ok: false, error: result.error };
      // Empty models[] still counts as "reachable" — claude.exe spawned and
      // exchanged frames with the relay. The DEFAULT_MODELS fallback path in
      // refreshModels covers what gets shown to the user.
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * One-off message creation against an existing endpoint. Used by the
   * renderer's `/compact` command to summarise a transcript without spinning
   * up a claude.exe child. Reads the plaintext key via `getPlainKey` (same
   * flow as `refreshModels`) so the renderer never sees it directly.
   */
  async createMessage(args: {
    endpointId: string;
    model: string;
    maxTokens?: number;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    system?: string;
  }): Promise<{ ok: true; text: string } | { ok: false; status?: number; error: string }> {
    const endpoint = this.getEndpoint(args.endpointId);
    if (!endpoint) return { ok: false, error: 'Endpoint not found' };
    const apiKey = this.getPlainKey(args.endpointId) ?? '';
    if (!apiKey) return { ok: false, error: 'Endpoint has no API key configured' };
    const base = normaliseBaseUrl(endpoint.baseUrl);
    const url = `${base}/v1/messages`;
    const body: Record<string, unknown> = {
      model: args.model,
      max_tokens: args.maxTokens ?? 4000,
      messages: args.messages
    };
    if (args.system) body.system = args.system;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...buildAnthropicHeaders(apiKey),
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await safeReadText(res);
        return {
          ok: false,
          status: res.status,
          error: describeHttpError(res.status, text)
        };
      }
      const json = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const parts = Array.isArray(json.content) ? json.content : [];
      const text = parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n')
        .trim();
      if (!text) {
        return { ok: false, error: 'Empty response from model' };
      }
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Discover the endpoint's model list by spawning claude.exe (the only
   * thing that knows how to talk to relays + bedrock + vertex + canonical
   * Anthropic without us re-implementing every backend), and merge in the
   * user's manual ids. If claude.exe can't tell us anything, fall back to
   * `DEFAULT_MODELS` so the model picker is never empty for a working
   * endpoint.
   *
   * Source taxonomy after this runs:
   *   - 'listed'   — claude.exe init frame OR initialize-rpc reported it.
   *   - 'fallback' — DEFAULT_MODELS surfaced because claude.exe came back
   *                  empty (relay reachable, just no catalogue).
   *   - 'manual'   — user-typed id; flagged `existsConfirmed: false` unless
   *                  it overlapped with a 'listed' result (in which case it
   *                  rides on the listed entry).
   */
  async refreshModels(
    endpointId: string
  ): Promise<
    | { ok: true; count: number; detectedKind: EndpointKind; sourceStats: Record<DiscoverySource, number> }
    | { ok: false; error: string; status?: number }
  > {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) return { ok: false, error: 'Endpoint not found' };
    const apiKey = this.getPlainKey(endpointId) ?? '';

    const result = await this.listModelsFn({
      baseUrl: endpoint.baseUrl,
      apiKey,
      binPath: this.getBinaryPath(),
    });

    if (!result.ok) {
      this.markEndpointStatus(endpointId, 'error', result.error);
      return { ok: false, error: result.error };
    }

    // Merge: listed (from claude.exe) ∪ DEFAULT_MODELS (only if listed empty)
    // ∪ manual (always, with existsConfirmed=false unless overlapping listed).
    const merged = new Map<string, { id: string; displayName?: string; source: DiscoverySource; existsConfirmed: boolean }>();
    for (const m of result.models) {
      if (!m.id) continue;
      merged.set(m.id, { id: m.id, displayName: m.displayName, source: 'listed', existsConfirmed: true });
    }
    if (merged.size === 0) {
      for (const id of DEFAULT_MODELS) {
        merged.set(id, { id, source: 'fallback', existsConfirmed: false });
      }
    }
    for (const raw of endpoint.manualModelIds) {
      const id = raw.trim();
      if (!id) continue;
      const prev = merged.get(id);
      if (prev) {
        // Tag as also-manual but keep the stronger source/confirmed flag.
        prev.source = prev.source === 'listed' ? 'listed' : 'manual';
      } else {
        merged.set(id, { id, source: 'manual', existsConfirmed: false });
      }
    }

    const now = this.now();
    const db = getDb();
    const detectedKind: EndpointKind = endpoint.kind ?? 'anthropic';
    const sourceStats: Record<DiscoverySource, number> = { listed: 0, fallback: 0, manual: 0 };
    const run = db.transaction(() => {
      db.prepare('DELETE FROM endpoint_models WHERE endpoint_id = ?').run(endpointId);
      const insert = db.prepare(
        `INSERT INTO endpoint_models (id, endpoint_id, model_id, display_name, discovered_at, source, exists_confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const m of merged.values()) {
        insert.run(
          randomUUID(),
          endpointId,
          m.id,
          m.displayName ?? null,
          now,
          m.source,
          m.existsConfirmed ? 1 : 0
        );
        sourceStats[m.source]++;
      }
      db.prepare(
        `UPDATE endpoints SET last_status = 'ok', last_error = NULL, last_refreshed_at = ?,
                               detected_kind = ?, updated_at = ?
         WHERE id = ?`
      ).run(now, detectedKind, now, endpointId);
    });
    run();

    return {
      ok: true,
      count: merged.size,
      detectedKind,
      sourceStats,
    };
  }

  // ---------- Helpers ----------

  private encryptKey(plain: string | undefined | null): Buffer | null {
    if (!plain) return null;
    if (!this.crypto.isAvailable()) return null;
    return this.crypto.encrypt(plain);
  }

  private markEndpointStatus(
    endpointId: string,
    status: EndpointStatus,
    error: string | null
  ): void {
    const now = this.now();
    getDb()
      .prepare(
        `UPDATE endpoints SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, error, now, endpointId);
  }
}

function parseManualIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function toEndpointRow(r: RawEndpoint): EndpointRow {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    kind: (r.kind as EndpointKind) ?? 'anthropic',
    isDefault: !!r.is_default,
    lastStatus: (r.last_status as EndpointStatus) ?? 'unchecked',
    lastError: r.last_error,
    lastRefreshedAt: r.last_refreshed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    detectedKind: (r.detected_kind as EndpointKind | null) ?? null,
    manualModelIds: parseManualIds(r.manual_model_ids),
  };
}

function toModelRow(r: RawModel): ModelRow {
  const source = (r.source as DiscoverySource | null) ?? 'listed';
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    modelId: r.model_id,
    displayName: r.display_name,
    discoveredAt: r.discovered_at,
    source,
    existsConfirmed: r.exists_confirmed == null ? true : r.exists_confirmed === 1,
  };
}

function normaliseBaseUrl(baseUrl: string): string {
  let u = baseUrl.trim();
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/v1$/i, '');
  return u;
}

function buildModelsUrl(
  baseUrl: string,
  query: { limit?: number; after_id?: string }
): string {
  const base = normaliseBaseUrl(baseUrl);
  const params = new URLSearchParams();
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.after_id) params.set('after_id', query.after_id);
  const qs = params.toString();
  return `${base}/v1/models${qs ? `?${qs}` : ''}`;
}

function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 512);
  } catch {
    return '';
  }
}

function describeHttpError(
  status: number,
  body: string,
  opts: { hasKey?: boolean } = {}
): string {
  if (status === 401 || status === 403) {
    if (opts.hasKey === false) {
      return `Endpoint requires a key \u2014 please enter one (HTTP ${status})`;
    }
    return `Authentication failed (HTTP ${status})`;
  }
  if (status === 404) return `Endpoint does not expose /v1/models (HTTP 404)`;
  if (status === 429) return `Rate limited by upstream (HTTP 429)`;
  if (status >= 500) return `Upstream error (HTTP ${status})`;
  return body ? `HTTP ${status}: ${body}` : `HTTP ${status}`;
}

export const __test__ = { buildModelsUrl, normaliseBaseUrl, buildAnthropicHeaders };
