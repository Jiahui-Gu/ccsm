// Extended-thinking token tiers. The user-facing dropdown maps directly
// onto the four CLI keyword tiers ("think", "think hard", "think harder",
// "ultrathink") plus an explicit off, mirroring the keyword detector
// upstream's CLI runs against prompt text. We surface them as discrete
// dropdown options on the StatusBar instead of trying to make the user
// memorize the keywords.
//
// Token caps are model-INDEPENDENT today; the function still takes a
// modelId so a future per-model branch can slot in here without churning
// every call site.
//
// Re-grep upstream when bumping the bundled SDK / extension version:
//   grep -E "max_thinking_tokens|ultrathink|think hard" extension.js
// (the literal cap for ultrathink upstream is currently 31999, identical
// to think_harder — they share a tier even though the keyword is
// distinct, so the dropdown shows both for parity with prompt-side
// keywords. Re-verify on SDK bump.)

export type ThinkingLevel =
  | 'off'
  | 'think'
  | 'think_hard'
  | 'think_harder'
  | 'ultrathink';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'think',
  'think_hard',
  'think_harder',
  'ultrathink',
] as const;

/**
 * Return the `max_thinking_tokens` value to send via the SDK control RPC
 * `set_max_thinking_tokens`. Tier values mirror the upstream CLI keyword
 * detector (extension v2.1.120). `modelId` is currently unused but kept
 * for a future model-aware branch.
 */
export function getMaxThinkingTokensForModel(
  modelId: string | undefined,
  level: ThinkingLevel,
): number {
  void modelId;
  switch (level) {
    case 'off':
      return 0;
    case 'think':
      return 4000;
    case 'think_hard':
      return 10000;
    case 'think_harder':
      return 31999;
    case 'ultrathink':
      // Upstream caps ultrathink at the same literal as think_harder
      // today; kept distinct here so the dropdown matches the four CLI
      // keywords. Re-verify on SDK bump.
      return 31999;
  }
}

/**
 * Coerce arbitrary strings (including the legacy `'default_on'` value
 * persisted by the original 2-state Switch) into the current union.
 * Unknown / malformed inputs return `null` so callers can decide whether
 * to fall back to a default or skip the entry. `'default_on'` migrates to
 * `'think_harder'` since both resolve to the same 31999 cap, preserving
 * the user's intent across the upgrade.
 */
export function coerceThinkingLevel(raw: unknown): ThinkingLevel | null {
  if (raw === 'off') return 'off';
  if (raw === 'think') return 'think';
  if (raw === 'think_hard') return 'think_hard';
  if (raw === 'think_harder') return 'think_harder';
  if (raw === 'ultrathink') return 'ultrathink';
  // Legacy value from the pre-dropdown 2-state Switch. Same cap as
  // think_harder, so migrate without surprising the user.
  if (raw === 'default_on') return 'think_harder';
  return null;
}
