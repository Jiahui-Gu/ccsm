// Unified 6-tier effort + thinking chip in StatusBar.
//
// CCSM merges the SDK's two orthogonal dimensions — `effort` (low/medium/
// high/xhigh/max) and `thinking` (adaptive/disabled) — into a single chip
// users actually maintain. The mapping below is a deliberate ccsm product
// decision: the bundled VS Code extension exposes the two dimensions as
// separate controls, but in dogfood we never set them independently —
// "thinking off" always means "low effort", and any thinking-on tier
// implicitly enables `adaptive`. One chip = one less thing to maintain.
//
// Mapping (single source of truth):
//
//   Off           thinking=disabled   effort=undefined  (chip label: "Off")
//   Low           thinking=adaptive   effort=low
//   Medium        thinking=adaptive   effort=medium
//   High          thinking=adaptive   effort=high       <- default
//   Extra high    thinking=adaptive   effort=xhigh      (model-gated)
//   Max           thinking=adaptive   effort=max        (model-gated)
//
// Wire path (mirrors SDK schema):
//   - Launch:      query({ thinking, effort })
//   - Mid-session: concurrent setMaxThinkingTokens(null|0) + applyFlagSettings({effortLevel})
//   - Persistence: settings.json effortLevel (CLI reads via CLAUDE_CONFIG_DIR;
//                  ccsm does NOT parse settings.json — see project_cli_config_reuse memory).
//
// Model gating: we prefer the SDK's own `Model.supportedEffortLevels` (piped
// in per-model via the `agent:modelInfo` IPC channel — see
// `electron/agent-sdk/sessions.ts` and the renderer wiring in
// `src/agent/lifecycle.ts`). When no SDK report is available yet — e.g.
// before the first session starts in an app run — we fall back to a small
// hardcoded model→tier table inside `supportedEffortLevelsForModel`. Gated
// tiers render `disabled` in the dropdown with a "not supported by current
// model" tooltip.

export type EffortLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'high';

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * SDK `ThinkingConfig` projection. We only ever emit `adaptive` (Claude
 * decides budget) or `disabled` — ccsm does not surface the intermediate
 * `enabled` mode (fixed token budget for older models). The 6-tier chip
 * abstracts this entirely.
 */
export type ThinkingConfigProjection =
  | { type: 'adaptive' }
  | { type: 'disabled' };

export interface EffortWireOptions {
  /** ThinkingConfig to pass to `query({ thinking })`. */
  thinking: ThinkingConfigProjection;
  /**
   * `effort` to pass to `query({ effort })`. Undefined when level is 'off' —
   * the SDK then uses the model default (which is irrelevant when thinking
   * is disabled).
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Project a chip level into the SDK's two dimensions for `query()` launch.
 * Mid-session changes go through a different path (two concurrent control
 * RPCs) — see SdkSessionRunner.setEffort.
 */
export function projectEffortToWire(level: EffortLevel): EffortWireOptions {
  if (level === 'off') {
    return { thinking: { type: 'disabled' } };
  }
  return {
    thinking: { type: 'adaptive' },
    effort: level,
  };
}

/**
 * Maximum thinking-tokens value to pass to the legacy `setMaxThinkingTokens`
 * control RPC during a mid-session change. The SDK accepts `null` (enable
 * adaptive thinking) or `0` (disable). Any positive number would map to
 * the deprecated `enabled` mode which we never use.
 *
 * This is the FIRST of the two concurrent RPCs sent on mid-session change.
 * The SECOND is `applyFlagSettings({ effortLevel })` — which carries the
 * actual tier.
 */
export function thinkingTokensForLevel(level: EffortLevel): number | null {
  return level === 'off' ? 0 : null;
}

/**
 * Resolve the set of NON-'off' tiers a given model supports. 'off' is always
 * usable (it is purely a ccsm-side toggle: thinking=disabled).
 *
 * Resolution order:
 *   1. `sdkReported` — the SDK's own `Model.supportedEffortLevels` for this
 *      model id, populated on session start via `query.supportedModels()`
 *      (see electron/agent-sdk/sessions.ts and the `agent:modelInfo` IPC
 *      channel). This is the canonical answer when present, including
 *      future model additions ccsm hasn't been recompiled for.
 *   2. Hardcoded fallback below — used when no SDK report has arrived yet
 *      (no session has started in this app run, or the running SDK build
 *      doesn't list the chosen model). Mirrors what the bundled CLI
 *      reported in dogfood at the time of writing:
 *
 *        Opus 4.7    → low, medium, high, xhigh, max
 *        Opus 4.6    → low, medium, high, max
 *        Sonnet 4.6+ → low, medium, high
 *        Older       → low, medium, high  (always-safe trio; the chip still
 *                      works so a model swap picks up support without a
 *                      relaunch).
 */
export function supportedEffortLevelsForModel(
  modelId: string | null | undefined,
  sdkReported?: Readonly<
    Record<string, ReadonlyArray<Exclude<EffortLevel, 'off'>>>
  >
): ReadonlySet<Exclude<EffortLevel, 'off'>> {
  const id = (modelId ?? '').toLowerCase();
  if (sdkReported && modelId) {
    // Try the exact id the SDK reported with first; fall back to a
    // case-insensitive lookup so callers don't have to care about how the
    // CLI spells the canonical id (e.g. `claude-opus-4-7-...` vs the
    // user-facing alias).
    const exact = sdkReported[modelId];
    if (exact && exact.length > 0) return new Set(exact);
    for (const [k, v] of Object.entries(sdkReported)) {
      if (k.toLowerCase() === id && v.length > 0) return new Set(v);
    }
  }
  // Order matters: opus-4-7 must be tested before opus-4 (substring match).
  if (/opus-4[-_]7|opus-4\.7/.test(id)) {
    return new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  }
  if (/opus-4[-_]6|opus-4\.6|opus-4(?![-_.\d])/.test(id)) {
    return new Set(['low', 'medium', 'high', 'max']);
  }
  if (/sonnet-4|sonnet/.test(id)) {
    return new Set(['low', 'medium', 'high']);
  }
  // Unknown model: surface the always-safe trio.
  return new Set(['low', 'medium', 'high']);
}

export function isEffortLevelSupported(
  modelId: string | null | undefined,
  level: EffortLevel,
  sdkReported?: Readonly<
    Record<string, ReadonlyArray<Exclude<EffortLevel, 'off'>>>
  >
): boolean {
  if (level === 'off') return true;
  return supportedEffortLevelsForModel(modelId, sdkReported).has(level);
}

/**
 * Coerce an arbitrary value (legacy persisted state, untrusted IPC payload)
 * back into the strict `EffortLevel` union. Returns the default for any
 * unrecognised input. Used by `migrateEffortLevel` and IPC validation.
 */
export function coerceEffortLevel(raw: unknown): EffortLevel {
  if (
    raw === 'off' ||
    raw === 'low' ||
    raw === 'medium' ||
    raw === 'high' ||
    raw === 'xhigh' ||
    raw === 'max'
  ) {
    return raw;
  }
  return DEFAULT_EFFORT_LEVEL;
}
