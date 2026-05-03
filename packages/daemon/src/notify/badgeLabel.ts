// Pure label decider for the unread badge.
//
// Display rule (preserved verbatim from electron/notify/badge.ts):
//   * n <= 0      -> ''     (no badge)
//   * 1 <= n <= 9 -> '<n>'
//   * n >= 10     -> '9+'
//
// Phase A of Task #722: this duplicates `badgeLabel` from badge.ts. Phase B
// will switch the import in badge.ts and delete the original.

export function badgeLabel(n: number): string {
  if (n <= 0) return '';
  if (n >= 10) return '9+';
  return String(n);
}
