/**
 * Discover the model list available to the user by reading
 * `~/.claude/settings.json` + relevant ANTHROPIC_* environment variables, then
 * merging in the user's manually-typed model ids and a small static fallback.
 *
 * Why this replaced the previous `listModelsViaClaude` (PR #95):
 *   - Anthropic-style relays (Claude-Code-Router, LiteLLM, simple proxies) do
 *     NOT expose `/v1/models` (returns 404), and claude.exe's stream-json init
 *     frame only echoes the *current session's* model — there is no "list
 *     everything" frame or RPC. Spawning claude.exe to discover models
 *     therefore timed out at 25s while waiting for a list that never comes.
 *   - The most reliable signal of "what models can this user use" is exactly
 *     what the CLI itself reads on every launch: settings.json + env vars.
 *
 * This module is pure — no spawning, no HTTP, no writes — so it is fast,
 * deterministic, and safe to call from anywhere on the main process.
 *
 * Sources surfaced (in priority order):
 *   - 'settings'     — `settings.json` `model` field or `env.ANTHROPIC_*_MODEL`
 *   - 'env'          — process env `ANTHROPIC_*_MODEL` not already in settings
 *   - 'manual'       — user-typed ids from the endpoint Settings UI
 *   - 'cli-picker'   — hardcoded mirror of claude.exe's `/model` picker
 *   - 'env-override' — per-tier `ANTHROPIC_DEFAULT_<TIER>_MODEL` overrides
 *   - 'fallback'     — static last-resort triple
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_PICKER_MODELS, getCustomEnvOverrides } from './cli-picker-models';

export type ModelSource =
  | 'settings'
  | 'env'
  | 'manual'
  | 'cli-picker'
  | 'env-override'
  | 'fallback';

export interface DiscoveredModel {
  id: string;
  source: ModelSource;
}

export interface ListModelsResult {
  ok: true;
  models: DiscoveredModel[];
}

export interface ListModelsFromSettingsOpts {
  /** User-typed extra model ids (Settings UI). */
  manualModelIds?: string[];
  /** Override the config dir. Defaults to `<homedir>/.claude`. Tests pass a fixture path. */
  configDir?: string;
  /** Override process env. Tests inject; production passes nothing. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Hardcoded last-resort list when both settings.json and env yield nothing.
 * Three current Claude 4.x-tier aliases — chosen so the model picker is never
 * empty for a working endpoint and the user can always type more into
 * `manualModelIds`.
 */
export const FALLBACK_MODELS: readonly string[] = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/**
 * Env-var names the CLI consults for default model selection. Order doesn't
 * matter for discovery (we collect all that are set) — only for which flag the
 * CLI ultimately picks at session start, which isn't our concern here.
 */
const ENV_MODEL_KEYS: readonly string[] = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

interface SettingsShape {
  model?: unknown;
  env?: unknown;
}

async function readSettings(configDir: string): Promise<SettingsShape | null> {
  const file = path.join(configDir, 'settings.json');
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    // ENOENT or permission error — treat as "nothing to merge", not an error.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SettingsShape;
    return null;
  } catch {
    // Malformed JSON: ignore so a hand-edited settings.json doesn't break the
    // model picker. Fallback list still applies.
    return null;
  }
}

/** Collect string ids from a single env-shaped record, in ENV_MODEL_KEYS order. */
function collectFromEnvLike(envLike: Record<string, unknown> | undefined): string[] {
  if (!envLike || typeof envLike !== 'object') return [];
  const out: string[] = [];
  for (const key of ENV_MODEL_KEYS) {
    const v = envLike[key];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Read the user's CLI default-model preference from `~/.claude/settings.json`'s
 * top-level `model` field. This is exactly the value the CLI itself consults
 * for `claude --model` defaulting, so reusing it makes ccsm's new-session
 * default match what the user already configured for the CLI — no second
 * source of truth, no frequency vote, no surprise model id that isn't even
 * in the picker list.
 *
 * Returns `null` when settings.json is missing, malformed, or has no `model`
 * field (in which case callers should fall through to whatever else they
 * track — e.g. the SDK's own default, the connection profile, or the first
 * discovered model). Never throws.
 */
export async function readDefaultModelFromSettings(
  configDir?: string,
): Promise<string | null> {
  const dir =
    configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const settings = await readSettings(dir);
  if (!settings) return null;
  if (typeof settings.model !== 'string') return null;
  const trimmed = settings.model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Discover models. Always resolves to `{ ok: true }` — even if every source
 * fails, the FALLBACK list guarantees a non-empty result for the UI.
 */
export async function listModelsFromSettings(
  opts: ListModelsFromSettingsOpts = {},
): Promise<ListModelsResult> {
  const configDir = opts.configDir ?? path.join(os.homedir(), '.claude');
  const env = opts.env ?? process.env;

  const settings = await readSettings(configDir);

  // Dedupe by id, first-source-wins. Insertion order = priority order:
  //   settings → env → manual → cli-picker → env-override → fallback.
  // Rationale: anything the user has actually configured (settings/env/manual)
  // should keep its precise source tag; the hardcoded CLI picker entries fill
  // in the canonical alias set every install ships with; the env-override
  // entries (ANTHROPIC_DEFAULT_<TIER>_MODEL with companion NAME/DESCRIPTION)
  // come last among "synthetic" sources so a user-typed manual id wins; the
  // static fallback triple guarantees the picker is never empty.
  const merged = new Map<string, DiscoveredModel>();
  const add = (id: string | undefined, source: ModelSource): void => {
    if (!id) return;
    const trimmed = id.trim();
    if (!trimmed) return;
    if (merged.has(trimmed)) return;
    merged.set(trimmed, { id: trimmed, source });
  };

  // 1) settings.model + settings.env.<MODEL_KEYS>
  if (settings) {
    if (typeof settings.model === 'string') {
      add(settings.model, 'settings');
    }
    const settingsEnv =
      settings.env && typeof settings.env === 'object'
        ? (settings.env as Record<string, unknown>)
        : undefined;
    for (const id of collectFromEnvLike(settingsEnv)) {
      // settings.env entries are still 'settings' source — they live in the
      // settings file, not the actual process env.
      add(id, 'settings');
    }
  }

  // 2) process.env (overrides settings.env per CLI convention — but since
  // first-write-wins, anything already in `merged` from settings stays as
  // 'settings'. For ids only present in process.env we tag 'env'.)
  for (const id of collectFromEnvLike(env as Record<string, unknown>)) {
    add(id, 'env');
  }

  // 3) Manual ids — user-typed in the endpoint Settings UI.
  for (const id of opts.manualModelIds ?? []) {
    add(id, 'manual');
  }

  // 4) Hardcoded CLI picker list (claude.exe bundle factory). These are the
  // aliases every CLI install offers via `/model`; they don't depend on
  // settings.json or the active relay.
  for (const m of CLI_PICKER_MODELS) {
    add(m.id, 'cli-picker');
  }

  // 5) Per-tier env-var overrides (ANTHROPIC_DEFAULT_<TIER>_MODEL etc.).
  // Tagged distinctly from 'env' so the UI can show "user customized this
  // tier's default" separately from a raw ANTHROPIC_MODEL setting.
  for (const m of getCustomEnvOverrides(env)) {
    add(m.id, 'env-override');
  }

  // 6) Static fallback so the picker is never empty.
  for (const id of FALLBACK_MODELS) {
    add(id, 'fallback');
  }

  return { ok: true, models: Array.from(merged.values()) };
}
