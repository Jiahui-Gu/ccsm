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
//   Extra high    thinking=adaptive   effort=xhigh
//   Max           thinking=adaptive   effort=max
//
// Wire path (mirrors SDK schema):
//   - Launch:      query({ thinking, effort })
//   - Mid-session: concurrent setMaxThinkingTokens(null|0) + applyFlagSettings({effortLevel})
//   - Persistence: settings.json effortLevel (CLI reads via CLAUDE_CONFIG_DIR;
//                  ccsm does NOT parse settings.json — see project_cli_config_reuse memory).
//
// Model gating: ccsm is OPTIMISTIC. Every chip tier is enabled in the UI
// regardless of which model the user picked — the chip never disables itself
// or shows a "not supported" tooltip. If the CLI rejects the chosen tier (for
// either a launch or mid-session apply), the runner auto-downgrades one tier
// at a time (max → xhigh → high → medium → low → off) and retries until the
// CLI accepts. The chip's visible label keeps showing the user-selected tier
// — the downgrade is invisible at the UI layer, only logged via diagnostic.
//
// Why optimistic instead of a hardcoded model→tiers table or piping the SDK's
// `Model.supportedEffortLevels` into a `disabled+tooltip` UI: alias model ids
// (e.g. CLI picker `opus[1m]` → real id `claude-opus-4-7-1m`) defeat regex-
// based gating, and the SDK report only arrives once a session has started
// — so a fresh chip on app launch had no usable info anyway. The downgrade
// loop is a single source of truth that works for every model the CLI knows
// about, including aliases and future additions ccsm hasn't been recompiled
// for.

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
 * Optimistic-fallback ladder. Returns the next-lower tier to try after the
 * CLI rejected the current one, or `null` once we've reached the bottom
 * ('off' is always accepted because it's purely a ccsm-side toggle: thinking=disabled,
 * no effort sent).
 *
 * Order: max → xhigh → high → medium → low → off → null.
 *
 * Used by `electron/agent-sdk/sessions.ts` on both launch (query() rejected
 * for unsupported `effort`) and mid-session (`apply_flag_settings` rejected).
 */
export function nextLowerEffort(level: EffortLevel): EffortLevel | null {
  switch (level) {
    case 'max':
      return 'xhigh';
    case 'xhigh':
      return 'high';
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    case 'low':
      return 'off';
    case 'off':
      return null;
  }
}

/**
 * Heuristic to decide whether an SDK / CLI error message indicates the
 * `effort` (or its underlying `thinking` dimension) was rejected and the
 * runner should auto-downgrade. Bundled CLI rejections come back as plain
 * `Error(W.error)` (see `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
 * `pendingControlResponses` handler) — the only signal is the message text,
 * and the CLI's exact wording varies across versions. The regex matches the
 * intersection of words seen in dogfood and is intentionally permissive —
 * a false positive just means a one-tier downgrade on a different class of
 * error (still ends up at `off` and surfaces the original error if even
 * `off` fails).
 */
export function isEffortRejectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!msg) return false;
  // Match any of:
  //   - phrases mentioning "effort" with unsupported/invalid/not-supported
  //   - phrases mentioning "thinking" with unsupported/invalid/not-supported
  //   - flag_settings rejections that name effortLevel
  return (
    /\beffort\b[^.]{0,60}\b(unsupported|not\s+supported|invalid|unknown|disallow|not\s+allowed)\b/i.test(msg) ||
    /\b(unsupported|not\s+supported|invalid|unknown|disallow|not\s+allowed)\b[^.]{0,60}\beffort\b/i.test(msg) ||
    /\bthinking\b[^.]{0,60}\b(unsupported|not\s+supported|invalid|unknown|disallow|not\s+allowed)\b/i.test(msg) ||
    /\b(unsupported|not\s+supported|invalid|unknown|disallow|not\s+allowed)\b[^.]{0,60}\bthinking\b/i.test(msg) ||
    /\beffortLevel\b/i.test(msg)
  );
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
