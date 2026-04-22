/**
 * Hardcoded mirror of Claude Code CLI's `/model` slash-command picker list.
 *
 * Why this exists:
 *   - The CLI's `/model` picker is built from a factory function compiled into
 *     the `claude.exe` bundle (extracted from v2.1.114). It does NOT come from
 *     ~/.claude/settings.json, does NOT come from any HTTP endpoint, and does
 *     NOT depend on the active relay — that is precisely why these aliases
 *     keep working when users point claude.exe at a third-party gateway.
 *   - PR #97 reads settings.json + ANTHROPIC_*_MODEL env vars to find ids the
 *     user has configured. That's the right signal for "what has this user
 *     wired up", but it misses the canonical alias set every CLI install
 *     ships with (sonnet / opus / haiku + 1M variants + legacy entries). The
 *     model picker should always offer those, even on a fresh install with
 *     no settings.json model overrides.
 *
 * This file is a pure data table — no spawning, no I/O, no network. Update
 * when a new claude.exe bundle ships a new picker entry.
 */

export interface CliPickerModel {
  /** The id passed via `--model` / written into settings.json (e.g. `sonnet`,
   *  `opus[1m]`, `claude-opus-4-1`). For the alias entries (`sonnet`/`opus`/
   *  `haiku`) the CLI later resolves to a concrete model id internally; we
   *  keep the alias because that's what the picker shows and what users type. */
  id: string;
  /** Short label shown as the primary text in the picker. */
  label: string;
  /** One-line description shown under the label in the picker. */
  description: string;
}

/**
 * The CLI's hardcoded picker entries (claude.exe v2.1.114). The "Default
 * (recommended)" entry is intentionally omitted — that's a sentinel for
 * "use whatever the CLI decides" and is not a model id we can pass through.
 *
 * Frozen so callers cannot mutate the shared instance at runtime.
 */
export const CLI_PICKER_MODELS: ReadonlyArray<CliPickerModel> = Object.freeze([
  Object.freeze({
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Sonnet 4.6 \u00B7 Best for everyday tasks',
  }),
  Object.freeze({
    id: 'opus',
    label: 'Opus',
    description: 'Opus 4.7 \u00B7 Most capable for complex work',
  }),
  Object.freeze({
    id: 'haiku',
    label: 'Haiku',
    description: 'Haiku 4.5 \u00B7 Fast and lightweight',
  }),
  Object.freeze({
    id: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: 'Sonnet 4.6 with 1M context window',
  }),
  Object.freeze({
    id: 'opus[1m]',
    label: 'Opus 4.7 (1M context)',
    description: 'Opus 4.7 with 1M context window',
  }),
  Object.freeze({
    id: 'claude-opus-4-6[1m]',
    label: 'Opus 4.6 (1M context)',
    description: 'Opus 4.6 with 1M context window',
  }),
  Object.freeze({
    id: 'claude-opus-4-1',
    label: 'Opus 4.1',
    description: 'Opus 4.1 \u00B7 Legacy',
  }),
]) as ReadonlyArray<CliPickerModel>;

/**
 * Per-tier env-var triples consulted by the CLI for "default <tier> model"
 * overrides. Order matters only for stable iteration (tests assert on it).
 */
interface TierEnvSpec {
  tier: 'Sonnet' | 'Opus' | 'Haiku';
  modelKey: string;
  nameKey: string;
  descriptionKey: string;
}

const TIER_ENV_SPECS: ReadonlyArray<TierEnvSpec> = [
  {
    tier: 'Sonnet',
    modelKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    nameKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    descriptionKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  },
  {
    tier: 'Opus',
    modelKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    nameKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    descriptionKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  },
  {
    tier: 'Haiku',
    modelKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    nameKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    descriptionKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  },
];

function readTrimmedString(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * Surface user-defined overrides of the CLI's default tier models. When the
 * user sets e.g. `ANTHROPIC_DEFAULT_SONNET_MODEL=foo-model`, the CLI uses
 * that whenever it would otherwise resolve `sonnet`. Optional companion vars
 * `..._MODEL_NAME` / `..._MODEL_DESCRIPTION` let users brand the entry; if
 * absent we fall back to "Custom <Tier> model" / empty description.
 *
 * These are intentionally separate from the static {@link CLI_PICKER_MODELS}
 * list — the CLI shows both, and so do we. Returns an empty array when no
 * tier vars are set.
 */
export function getCustomEnvOverrides(
  env: NodeJS.ProcessEnv = process.env,
): CliPickerModel[] {
  const out: CliPickerModel[] = [];
  for (const spec of TIER_ENV_SPECS) {
    const id = readTrimmedString(env, spec.modelKey);
    if (!id) continue;
    const label = readTrimmedString(env, spec.nameKey) ?? `Custom ${spec.tier} model`;
    const description = readTrimmedString(env, spec.descriptionKey) ?? '';
    out.push({ id, label, description });
  }
  return out;
}
