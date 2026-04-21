import { randomUUID } from 'node:crypto';
import { getDb } from './db';

/**
 * Phase 1 supports Anthropic-native protocol only. Other kinds are reserved
 * for Phase 2 (OpenAI-compat, Ollama, Bedrock, Vertex). Stored as a free TEXT
 * column so Phase 2 can add values without a schema migration.
 */
export type EndpointKind = 'anthropic';

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
}

export interface ModelRow {
  id: string;
  endpointId: string;
  modelId: string;
  displayName: string | null;
  discoveredAt: number;
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
}

/**
 * Abstraction over Electron's `safeStorage`. We inject it so unit tests can
 * run the DB layer without spinning up Electron, and so the codebase has a
 * single plaintext→ciphertext boundary we can audit.
 */
export interface KeyCrypto {
  isAvailable: () => boolean;
  encrypt: (plain: string) => Buffer;
  decrypt: (cipher: Buffer) => string;
}

type FetchLike = typeof fetch;

export interface EndpointsManagerDeps {
  crypto: KeyCrypto;
  fetchImpl?: FetchLike;
  now?: () => number;
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
}

interface RawModel {
  id: string;
  endpoint_id: string;
  model_id: string;
  display_name: string | null;
  discovered_at: number;
}

/**
 * Anthropic's `GET /v1/models` response page.
 * https://docs.anthropic.com/en/api/models-list
 */
interface AnthropicModelsPage {
  data: Array<{
    id: string;
    display_name?: string;
    type?: string;
    created_at?: string;
  }>;
  has_more: boolean;
  first_id?: string | null;
  last_id?: string | null;
}

export class EndpointsManager {
  private readonly crypto: KeyCrypto;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(deps: EndpointsManagerDeps) {
    this.crypto = deps.crypto;
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.now = deps.now ?? (() => Date.now());
  }

  // ---------- CRUD ----------

  listEndpoints(): EndpointRow[] {
    const rows = getDb()
      .prepare(
        `SELECT id, name, base_url, kind, api_key_encrypted, is_default,
                last_status, last_error, last_refreshed_at, created_at, updated_at
         FROM endpoints ORDER BY is_default DESC, created_at ASC`
      )
      .all() as RawEndpoint[];
    return rows.map(toEndpointRow);
  }

  getEndpoint(id: string): EndpointRow | null {
    const row = getDb()
      .prepare(
        `SELECT id, name, base_url, kind, api_key_encrypted, is_default,
                last_status, last_error, last_refreshed_at, created_at, updated_at
         FROM endpoints WHERE id = ?`
      )
      .get(id) as RawEndpoint | undefined;
    return row ? toEndpointRow(row) : null;
  }

  /**
   * Plaintext key read. Main-process only — never expose via IPC to the
   * renderer. Used by session spawn to set per-session env.
   */
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
          last_status, last_error, last_refreshed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'unchecked', NULL, NULL, ?, ?)`
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
          `UPDATE endpoints SET name = ?, base_url = ?, is_default = ?, updated_at = ?
           WHERE id = ?`
        ).run(name, baseUrl, isDefault ? 1 : 0, now, id);
      } else {
        db.prepare(
          `UPDATE endpoints SET name = ?, base_url = ?, api_key_encrypted = ?, is_default = ?, updated_at = ?
           WHERE id = ?`
        ).run(name, baseUrl, enc, isDefault ? 1 : 0, now, id);
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
      // Promote the oldest remaining endpoint to default if we removed the default.
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

  // ---------- Models ----------

  listModels(endpointId: string): ModelRow[] {
    const rows = getDb()
      .prepare(
        `SELECT id, endpoint_id, model_id, display_name, discovered_at
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
   * Lightweight connectivity probe. Issues `GET {baseUrl}/v1/models?limit=1`
   * with the provided key and surfaces a structured result. Does NOT write to
   * the DB — caller decides whether to persist status.
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
      if (!res.ok) {
        const body = await safeReadText(res);
        return {
          ok: false,
          status: res.status,
          error: describeHttpError(res.status, body, { hasKey: args.apiKey.length > 0 }),
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Fetch all pages of `GET /v1/models`, upsert into `endpoint_models`, and
   * prune rows no longer present upstream. Updates endpoint last_status.
   */
  async refreshModels(
    endpointId: string
  ): Promise<{ ok: true; count: number } | { ok: false; error: string; status?: number }> {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) return { ok: false, error: 'Endpoint not found' };
    const apiKey = this.getPlainKey(endpointId) ?? '';

    const collected: AnthropicModelsPage['data'] = [];
    let afterId: string | undefined;
    const pageLimit = 1000; // 100 models/page × 10 pages ceiling — plenty

    for (let page = 0; page < 10; page++) {
      const url = buildModelsUrl(endpoint.baseUrl, {
        limit: 100,
        after_id: afterId,
      });
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: buildAnthropicHeaders(apiKey),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.markEndpointStatus(endpointId, 'error', msg);
        return { ok: false, error: msg };
      }
      if (!res.ok) {
        const body = await safeReadText(res);
        const msg = describeHttpError(res.status, body);
        this.markEndpointStatus(endpointId, 'error', msg);
        return { ok: false, error: msg, status: res.status };
      }
      let payload: AnthropicModelsPage;
      try {
        payload = (await res.json()) as AnthropicModelsPage;
      } catch (err) {
        const msg = `Malformed /v1/models response: ${err instanceof Error ? err.message : String(err)}`;
        this.markEndpointStatus(endpointId, 'error', msg);
        return { ok: false, error: msg };
      }
      if (!payload || !Array.isArray(payload.data)) {
        const msg = 'Malformed /v1/models response: missing data array';
        this.markEndpointStatus(endpointId, 'error', msg);
        return { ok: false, error: msg };
      }
      collected.push(...payload.data);
      if (collected.length >= pageLimit) break;
      if (!payload.has_more) break;
      afterId = payload.last_id ?? payload.data[payload.data.length - 1]?.id;
      if (!afterId) break;
    }

    const now = this.now();
    const db = getDb();
    const run = db.transaction(() => {
      db.prepare('DELETE FROM endpoint_models WHERE endpoint_id = ?').run(endpointId);
      const insert = db.prepare(
        `INSERT INTO endpoint_models (id, endpoint_id, model_id, display_name, discovered_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const m of collected) {
        if (!m || typeof m.id !== 'string' || !m.id) continue;
        insert.run(randomUUID(), endpointId, m.id, m.display_name ?? null, now);
      }
      db.prepare(
        `UPDATE endpoints SET last_status = 'ok', last_error = NULL, last_refreshed_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(now, now, endpointId);
    });
    run();
    return { ok: true, count: collected.length };
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
  };
}

function toModelRow(r: RawModel): ModelRow {
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    modelId: r.model_id,
    displayName: r.display_name,
    discoveredAt: r.discovered_at,
  };
}

function normaliseBaseUrl(baseUrl: string): string {
  let u = baseUrl.trim();
  // Strip trailing /v1 or /v1/ so callers can paste either form.
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
  // `x-api-key` is the canonical header for Anthropic's REST API. Proxies that
  // emulate the Anthropic API generally accept it too. `anthropic-version` is
  // required by the official API; we use the baseline GA version for model
  // listing which has been stable since 2023-06-01.
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
