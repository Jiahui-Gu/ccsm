import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import {
  DiscoveryPipeline,
  type DiscoverySource,
  type EndpointKind as DiscoveryKind,
} from './endpoints-discovery';

/**
 * Endpoint "kind" spans the full taxonomy the discovery pipeline understands.
 * The `kind` stored at creation time is the user's *declared* kind (defaults
 * to anthropic); `detectedKind` is what the pipeline sniffed on last refresh.
 * We keep both because: (a) declared kind drives header choice in probes,
 * (b) detected kind is surfaced in the UI so users know what we think their
 * endpoint is.
 */
export type EndpointKind = DiscoveryKind;

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

export interface EndpointsManagerDeps {
  crypto: KeyCrypto;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Inject a pre-built pipeline (tests); otherwise one is built from fetchImpl. */
  pipeline?: DiscoveryPipeline;
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
  private readonly pipeline: DiscoveryPipeline;

  constructor(deps: EndpointsManagerDeps) {
    this.crypto = deps.crypto;
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.now = deps.now ?? (() => Date.now());
    this.pipeline = deps.pipeline ?? new DiscoveryPipeline({ fetchImpl: this.fetchImpl });
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
   * Lightweight connectivity probe. Tries GET /v1/models first (cheap); if
   * that 404s (relays that only expose /v1/messages) we probe a known
   * Anthropic model id via POST /v1/messages as a secondary signal. A plain
   * auth-failure on either branch is surfaced as-is.
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
      // /v1/models not supported — fall through to a probe.
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Secondary: run the discovery pipeline with a single canonical model;
    // if it comes back with any confirmed model we consider the endpoint live.
    try {
      const result = await this.pipeline.discover({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
      });
      if (!result.ok) {
        return { ok: false, status: result.status, error: result.error ?? 'Discovery failed' };
      }
      if (result.models.some((m) => m.existsConfirmed)) return { ok: true };
      return { ok: false, error: 'Endpoint reachable but no models discovered' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Run the tiered discovery pipeline and upsert into `endpoint_models`.
   * Replaces the old single-call /v1/models implementation.
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
    const knownModelIds = this.listModels(endpointId).map((m) => m.modelId);

    const result = await this.pipeline.discover({
      baseUrl: endpoint.baseUrl,
      apiKey,
      kind: endpoint.kind,
      knownModelIds,
      manualModelIds: endpoint.manualModelIds,
    });

    if (!result.ok) {
      this.markEndpointStatus(endpointId, 'error', result.error ?? 'Discovery failed');
      return { ok: false, error: result.error ?? 'Discovery failed', status: result.status };
    }

    const now = this.now();
    const db = getDb();
    const run = db.transaction(() => {
      db.prepare('DELETE FROM endpoint_models WHERE endpoint_id = ?').run(endpointId);
      const insert = db.prepare(
        `INSERT INTO endpoint_models (id, endpoint_id, model_id, display_name, discovered_at, source, exists_confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const m of result.models) {
        if (!m.id) continue;
        // Pick a single canonical source label for display. Priority:
        // listed > probe > manual, since that's increasing uncertainty.
        const primary: DiscoverySource = m.sources.includes('listed')
          ? 'listed'
          : m.sources.includes('probe')
          ? 'probe'
          : 'manual';
        insert.run(
          randomUUID(),
          endpointId,
          m.id,
          m.displayName ?? null,
          now,
          primary,
          m.existsConfirmed ? 1 : 0
        );
      }
      db.prepare(
        `UPDATE endpoints SET last_status = 'ok', last_error = NULL, last_refreshed_at = ?,
                               detected_kind = ?, updated_at = ?
         WHERE id = ?`
      ).run(now, result.detectedKind, now, endpointId);
    });
    run();

    return {
      ok: true,
      count: result.models.length,
      detectedKind: result.detectedKind,
      sourceStats: result.sourceStats,
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
