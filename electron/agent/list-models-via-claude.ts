/**
 * Discover the model list exposed by an Anthropic-compatible endpoint by
 * spawning `claude.exe` in stream-json mode and reading the answer it gives
 * us, instead of hitting `/v1/models` or probing `/v1/messages` ourselves.
 *
 * Why this is better than the old probe pipeline:
 *   - claude.exe already knows how to talk to every backend it supports
 *     (Anthropic canonical API, self-hosted relays / 中转, OAuth flows,
 *     Bedrock/Vertex). If `claude` can authenticate against an endpoint, it
 *     can list its models — by definition, since that's what it does on every
 *     real session start.
 *   - `/v1/models` is missing on most relays (Claude-Code-Router, LiteLLM,
 *     simple gateway proxies) — they only forward `/v1/messages`, so the old
 *     code returned 404 → "no models discovered" even though chats worked.
 *   - `/v1/messages` probes (POST with a 1-token message per candidate id)
 *     burned tokens, were rate-limit-prone, and still couldn't tell us about
 *     models we hadn't hardcoded.
 *
 * Strategy (cheapest signal first):
 *   1. Capture the first `system/init` frame. If it carries `models[]`
 *      (claude.exe ≥ 2.x roadmap; field is undocumented but `.passthrough()`
 *      on `SystemInitSchema` preserves it), we're done.
 *   2. Otherwise send a generic control_request `{subtype: 'initialize'}` and
 *      look for `models[]` on the response payload.
 *   3. If neither path yields anything, return ok with `models: []`. The
 *      caller is expected to merge a small `DEFAULT_MODELS` fallback +
 *      user-typed manual ids on top — that policy lives in the caller, not
 *      here, so this module stays a pure transport.
 *
 * Nothing in here writes to disk or to the user's `~/.claude` — we always
 * spawn with an isolated `CLAUDE_CONFIG_DIR` (caller supplies, mirroring the
 * sessions layer's contract).
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { spawnClaude } from './claude-spawner';
import { NDJSONSplitter } from './ndjson-splitter';

export interface ListModelsViaClaudeOpts {
  baseUrl: string;
  apiKey: string;
  binPath?: string;
  /**
   * Hard ceiling for the whole spawn → first-result lifecycle.
   * Defaults to 8000 ms to match the old discovery pipeline budget.
   */
  timeoutMs?: number;
  /**
   * Override the isolated CLAUDE_CONFIG_DIR. Tests pass a fixture path;
   * production callers leave undefined and we mint a fresh tmpdir.
   */
  configDir?: string;
  /** Override the cwd handed to claude. Tests pass a fixture path. */
  cwd?: string;
}

export interface DiscoveredModelEntry {
  id: string;
  displayName?: string;
}

export type ListModelsResult =
  | { ok: true; models: DiscoveredModelEntry[]; source: 'init' | 'initialize-rpc' | 'none' }
  | { ok: false; error: string };

interface RawModel {
  id?: string;
  model?: string;
  name?: string;
  display_name?: string;
  displayName?: string;
}

/**
 * Best-effort coerce of the various shapes a `models` field could take. The
 * stream-json schema doesn't pin this down (the field is passthrough), so we
 * accept either an array of strings ("claude-sonnet-4-5") or an array of
 * `{id, display_name}` objects. Anything else is dropped.
 */
function normaliseModels(raw: unknown): DiscoveredModelEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let id: string | undefined;
    let displayName: string | undefined;
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      const m = item as RawModel;
      id = (m.id ?? m.model ?? m.name ?? '').toString().trim() || undefined;
      displayName = m.display_name ?? m.displayName;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(displayName ? { id, displayName } : { id });
  }
  return out;
}

/**
 * Poke the spawned claude.exe for its model catalogue. Always graceful: any
 * thrown error (spawn failure, schema mismatch, timeout) is collapsed into
 * `{ ok:false, error }` so the caller can fall back without a try/catch.
 */
export async function listModelsViaClaude(
  opts: ListModelsViaClaudeOpts
): Promise<ListModelsResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const cwd = opts.cwd ?? process.cwd();

  // Use an isolated config dir per call so we never mutate the user's
  // ~/.claude (and so concurrent calls can't race on a shared cache file).
  let configDir = opts.configDir;
  let createdConfigDir = false;
  if (!configDir) {
    configDir = path.join(
      os.tmpdir(),
      `agentory-list-models-${randomUUID()}`,
    );
    try {
      await fsp.mkdir(configDir, { recursive: true });
      createdConfigDir = true;
    } catch (err) {
      return {
        ok: false,
        error: `failed to create config dir: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const envOverrides: Record<string, string> = {
    ANTHROPIC_BASE_URL: opts.baseUrl,
    // Authenticate via the bearer-style token slot so the same value works
    // against both api.anthropic.com (which accepts ANTHROPIC_API_KEY) and
    // self-hosted relays (which typically read ANTHROPIC_AUTH_TOKEN). We
    // populate both — claude.exe picks whichever its current backend cares
    // about.
    CLAUDE_CODE_SKIP_AUTH_LOGIN: 'true',
  };
  if (opts.apiKey) {
    envOverrides.ANTHROPIC_AUTH_TOKEN = opts.apiKey;
    envOverrides.ANTHROPIC_API_KEY = opts.apiKey;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  let proc;
  try {
    proc = await spawnClaude({
      cwd,
      configDir,
      envOverrides,
      binaryPath: opts.binPath,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (createdConfigDir) await fsp.rm(configDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      error: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cleanup = async (): Promise<void> => {
    clearTimeout(timer);
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    if (createdConfigDir) {
      // Don't await on cleanup of the tmp dir — it's a few KB and noise.
      void fsp.rm(configDir!, { recursive: true, force: true }).catch(() => {});
    }
  };

  // Bridge stdout NDJSON → typed frames. We don't use the full
  // stream-json-parser here because we only care about two frame types and
  // want to keep this hot path tiny.
  const splitter = new NDJSONSplitter(proc.stdout);
  const initRpcId = `req_${randomUUID()}`;
  let initRpcSent = false;

  return await new Promise<ListModelsResult>((resolve) => {
    let settled = false;
    const finish = (r: ListModelsResult): void => {
      if (settled) return;
      settled = true;
      splitter.detach();
      void cleanup();
      resolve(r);
    };

    ac.signal.addEventListener('abort', () => {
      finish({ ok: false, error: 'timeout' });
    });

    proc.wait().then(({ code, signal }) => {
      if (settled) return;
      const why = code === 0 || code === null
        ? 'claude exited before answering'
        : `claude exited code=${code}${signal ? ` signal=${signal}` : ''}`;
      const stderr = proc.getRecentStderr().trim();
      finish({ ok: false, error: stderr ? `${why}: ${stderr.slice(0, 256)}` : why });
    });

    splitter.on('error', () => {
      // Splitter errors (line cap exceeded, mid-byte UTF-8 at EOF) are
      // unrecoverable for our purposes — bail and let caller fall back.
      finish({ ok: false, error: 'stream-json parse error' });
    });

    splitter.on('line', (raw: string) => {
      let frame: { type?: string; subtype?: string; request_id?: string;
                   models?: unknown; response?: { models?: unknown; [k: string]: unknown };
                   [k: string]: unknown };
      try {
        frame = JSON.parse(raw);
      } catch {
        return; // skip garbage lines silently
      }

      // Path 1: models on the system/init frame (when present).
      if (frame.type === 'system' && frame.subtype === 'init') {
        const models = normaliseModels(frame.models);
        if (models.length > 0) {
          finish({ ok: true, models, source: 'init' });
          return;
        }
        // Path 2: ask politely.
        if (!initRpcSent) {
          initRpcSent = true;
          try {
            proc.stdin.write(
              JSON.stringify({
                type: 'control_request',
                request_id: initRpcId,
                request: { subtype: 'initialize' },
              }) + '\n',
            );
          } catch {
            // stdin closed — give up on path 2 and let the caller fall back.
            finish({ ok: true, models: [], source: 'none' });
          }
        }
        return;
      }

      if (
        frame.type === 'control_response' &&
        frame.request_id === initRpcId
      ) {
        const resp = frame.response ?? {};
        // Some backends echo `models` at the top level of the response, others
        // nest it under `response.models`. Try both.
        const models =
          normaliseModels(resp.models).length > 0
            ? normaliseModels(resp.models)
            : normaliseModels((frame as { models?: unknown }).models);
        if (models.length > 0) {
          finish({ ok: true, models, source: 'initialize-rpc' });
        } else {
          finish({ ok: true, models: [], source: 'none' });
        }
        return;
      }
    });
  });
}

// Test surface.
export const __test__ = { normaliseModels };
