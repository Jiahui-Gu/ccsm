// Extended-thinking token map. Mirrors the upstream VS Code extension's
// `getMaxThinkingTokensForModel(level)` so ccsm produces identical
// `set_max_thinking_tokens` payloads when the user toggles `/think`.
//
// The upstream value (extension v2.1.120) is model-INDEPENDENT today: it
// only branches on the level. Off → 0 (clears prior cap), default_on →
// 31999. The function still takes a modelId argument so a future upstream
// per-model branch can be slotted in here without churning every caller.
//
// Re-grep upstream when bumping the bundled SDK / extension version:
//   grep -E "getMaxThinkingTokensForModel|max_thinking_tokens" extension.js
// (look for the small literal-returning function — see commit message of the
// PR that introduced this file for the exact 2.1.120 snippet.)

export type ThinkingLevel = 'off' | 'default_on';

/**
 * Return the `max_thinking_tokens` value to send via the SDK control RPC
 * `set_max_thinking_tokens`. Matches upstream Claude Code VS Code extension
 * v2.1.120 byte-for-byte: 0 when off, 31999 in default_on.
 *
 * `modelId` is currently unused by upstream but accepted here to keep the
 * call sites stable across a future model-aware upstream change.
 */
export function getMaxThinkingTokensForModel(
  modelId: string | undefined,
  level: ThinkingLevel,
): number {
  // Suppress unused-arg warning without giving up the named parameter.
  void modelId;
  if (level === 'off') return 0;
  // Upstream literal (v2.1.120). Re-verify on SDK bump.
  return 31999;
}

/**
 * Toggle helper used by `/think` and the picker switch — flips between the
 * two values upstream actually supports. Anything richer (low/medium/high
 * tiers) is intentionally out of scope: upstream's UI is also a 2-state
 * Switch, not a slider.
 */
export function toggleThinkingLevel(level: ThinkingLevel): ThinkingLevel {
  return level === 'off' ? 'default_on' : 'off';
}
