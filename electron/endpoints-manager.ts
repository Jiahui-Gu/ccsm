import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import {
  listModelsFromSettings,
  type ModelSource,
} from './agent/list-models-from-settings';

/**
 * Endpoint "kind" — the user's declared backend type. `detectedKind` mirrors
 * `kind` after a successful refresh (the settings-based discovery does not
 * sniff endpoint shape; the field is preserved so DB schema / IPC surface
 * don't churn). The `bedrock`/`vertex` arms are only used by the renderer's
 * status chip.
 */
export type EndpointKind =
  | 'anthropic'
  | 'openai-compat'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'unknown';

/**
 * Model row source — one of:
 *   - 'listed'      — discovered from `~/.claude/settings.json` or matching
 *                     ANTHROPIC_* env vars (i.e. models the user has actually
 *                     configured the CLI to know about; collapses
 *                     `settings`/`env` from the discovery module).
 *   - 'cli-picker'  — entry from claude.exe's hardcoded `/model` picker list
 *                     (mirrored in `cli-picker-models.ts`). Always available
 *                     regardless of the active relay.
 *   - 'env-override'— per-tier `ANTHROPIC_DEFAULT_<TIER>_MODEL` override that
 *                     supplies a custom id + optional NAME/DESCRIPTION.
 *   - 'fallback'    — hardcoded triple from {@link listModelsFromSettings}.
 *   - 'manual'      — user-typed id from the endpoint Settings UI.
 *
 * Older rows may carry `'probe'` from before PR #95 — UI code treats unknown
 * variants as `'listed'`.
 */
export type DiscoverySource =
  | 'listed'
  | 'cli-picker'
  | 'env-override'
  | 'fallback'
  | 'manual';

/** Map the discovery module's source taxonomy onto our DB row taxonomy. */
function mapSource(s: ModelSource): DiscoverySource {
  if (s === 'manual') return 'manual';
  if (s === 'fallback') return 'fallback';
  if (s === 'cli-picker') return 'cli-picker';
  if (s === 'env-override') return 'env-override';
  // 'settings' and 'env' both mean "the CLI is configured to know about this
  // model" — collapse onto 'listed' which is what the UI surfaces.
  return 'listed';
}

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
 * Pluggable model-list fetcher. Production wiring reads
 * `~/.claude/settings.json` + ANTHROPIC_* env vars via
 * {@link listModelsFromSettings}; tests inject a stub. Always returns
 * `ok:true` (the underlying module guarantees a non-empty fallback).
 */
export type ListModelsFn = (args: {
  manualModelIds?: string[];
}) => Promise<{
  ok: true;
  models: Array<{ id: string; source: ModelSource }>;
}>;

export interface EndpointsManagerDeps {
  crypto: KeyCrypto;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Override the model lister (tests). Defaults to {@link listModelsFromSettings}. */
  listModels?: ListModelsFn;
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

  constructor(deps: EndpointsManagerDeps) {
    this.crypto = deps.crypto;
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.now = deps.now ?? (() => Date.now());
    this.listModelsFn = deps.listModels ?? ((args) => listModelsFromSettings(args));
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
    // Fire-and-forget: the UI calls this synchronously through IPC and
    // expects the new row back immediately; model discovery (local-only —
    // settings.json + env) runs in the background and writes sqlite for
    // the next `models:listByEndpoint` read.
    this.kickOffRefresh(id);
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
    // Fire-and-forget refresh: any of name/baseUrl/apiKey could affect what
    // the discovery sees (e.g. a newly-added key may unlock a relay that
    // gates model listings). Background it so the IPC call returns instantly.
    this.kickOffRefresh(id);
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
    // Fire-and-forget refresh: manual ids feed directly into the discovery
    // merge, so the persisted model set must be re-derived immediately.
    this.kickOffRefresh(id);
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
   * api.anthropic.com supports). On 401/403 we surface structured auth
   * failure. On 404 (most relays — Claude-Code-Router, LiteLLM, simple
   * gateways — don't expose `/v1/models`) we treat the endpoint as reachable:
   * the server *answered*, just not with a model catalogue. On 5xx / network
   * error we surface failure.
   *
   * Note: model discovery itself no longer goes through this path — it reads
   * `~/.claude/settings.json` locally via {@link listModelsFromSettings}, so
   * `testConnection` is purely a connectivity ping.
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
      if (res.status === 404) {
        // Relay doesn't expose /v1/models — but it answered HTTP, so call
        // it reachable. Models will come from settings.json on refresh.
        return { ok: true };
      }
      const body = await safeReadText(res);
      return {
        ok: false,
        status: res.status,
        error: describeHttpError(res.status, body),
      };
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
   * Discover the endpoint's model list by reading `~/.claude/settings.json`
   * + ANTHROPIC_* env vars (via {@link listModelsFromSettings}), with the
   * user's manual ids and a static fallback merged in. Always succeeds —
   * the underlying lister guarantees a non-empty result.
   *
   * Source taxonomy after this runs:
   *   - 'listed'       — discovered from settings.json or env (`settings`/`env`).
   *   - 'cli-picker'   — claude.exe's hardcoded `/model` picker entries.
   *   - 'env-override' — `ANTHROPIC_DEFAULT_<TIER>_MODEL` per-tier overrides.
   *   - 'manual'       — user-typed id from the Settings UI.
   *   - 'fallback'     — from the hardcoded `FALLBACK_MODELS` list.
   *
   * Note: this does NOT touch the network. The endpoint argument is used
   * only to scope DB writes / `lastRefreshedAt`. Reachability is a separate
   * concern — see {@link testConnection}.
   */
  async refreshModels(
    endpointId: string
  ): Promise<
    | { ok: true; count: number; detectedKind: EndpointKind; sourceStats: Record<DiscoverySource, number> }
    | { ok: false; error: string; status?: number }
  > {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint) return { ok: false, error: 'Endpoint not found' };

    const result = await this.listModelsFn({
      manualModelIds: endpoint.manualModelIds,
    });

    const now = this.now();
    const db = getDb();
    const detectedKind: EndpointKind = endpoint.kind ?? 'anthropic';
    const sourceStats: Record<DiscoverySource, number> = {
      listed: 0,
      'cli-picker': 0,
      'env-override': 0,
      fallback: 0,
      manual: 0,
    };
    const run = db.transaction(() => {
      db.prepare('DELETE FROM endpoint_models WHERE endpoint_id = ?').run(endpointId);
      const insert = db.prepare(
        `INSERT INTO endpoint_models (id, endpoint_id, model_id, display_name, discovered_at, source, exists_confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const m of result.models) {
        const source = mapSource(m.source);
        // Confirm entries that came from a real signal (settings/env/cli-picker
        // /env-override). Manual + fallback stay unconfirmed so the UI can
        // show "user-typed" / "guessed" hints if it wants to.
        const confirmed =
          source === 'listed' ||
          source === 'cli-picker' ||
          source === 'env-override';
        insert.run(
          randomUUID(),
          endpointId,
          m.id,
          null,
          now,
          source,
          confirmed ? 1 : 0,
        );
        sourceStats[source]++;
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
      count: result.models.length,
      detectedKind,
      sourceStats,
    };
  }

  // ---------- Helpers ----------

  /**
   * Schedule a background `refreshModels(id)`. Used by `addEndpoint`,
   * `updateEndpoint`, and `setManualModelIds` so the persisted model set
   * stays current without forcing IPC handlers to await network/local-IO
   * work. Errors are logged and swallowed — the original mutation already
   * succeeded; a failed refresh is non-fatal (the row will be re-tried on
   * next boot or via the manual "Refresh models" button).
   */
  private kickOffRefresh(endpointId: string): void {
    void this.refreshModels(endpointId).catch((err) => {
      console.warn(`[endpoints] background refresh failed for ${endpointId}:`, err);
    });
  }

  private encryptKey(plain: string | undefined | null): Buffer | null {
    if (!plain) return null;
    if (!this.crypto.isAvailable()) return null;
    return this.crypto.encrypt(plain);
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
