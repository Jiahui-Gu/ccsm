// Pure helpers for the user-owned cwd LRU.
//
// Extracted from electron/main.ts per #677 SRP — these functions have zero
// I/O (no SQLite, no fs, no electron imports) so they're trivially unit-
// testable and can be reused by future cwd consumers without dragging in
// the main-process module graph. The IPC handlers in main.ts call these
// pure helpers, then own the saveState side-effect themselves.
//
// Producer/decider/sink split:
//   - main.ts IPC handler reads from app_state (producer of raw list)
//   - this module decides the next list (decider — pure transform)
//   - main.ts writes back via saveState (sink)

/**
 * Trim trailing slashes/backslashes from a cwd. We deliberately don't
 * lower-case, expand `~`, or resolve symlinks here — Windows drive-letter
 * casing is preserved as-is, dedupe lower-cases on the comparison side.
 */
export function normalizeCwd(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/**
 * LRU-push `item` to the front of `list`, deduping case-insensitively
 * (Windows + macOS default fs are case-insensitive, so two cwds that
 * differ only in case are the same entry to the user). Caps the result
 * at `max` entries by dropping from the tail.
 *
 * Pure — does not mutate `list`.
 *
 * Empty/whitespace items are skipped (caller should pre-validate); we
 * just return `list` unchanged in that case so callers that route a
 * normalized-empty value through here don't accidentally clear the LRU.
 */
export function pushLRU(list: readonly string[], item: string, max = 20): string[] {
  if (!item) return [...list];
  const lower = item.toLowerCase();
  const without = list.filter((x) => x.toLowerCase() !== lower);
  return [item, ...without].slice(0, max);
}

/**
 * Append `home` to `list` if it isn't already present (case-insensitive).
 * Used by `getUserCwds` so the cwd popover always has at least the home
 * entry as a fallback target — the spec says "永远至少有 home" — without
 * bumping it back to the LRU head when the user has explicitly picked
 * other cwds since.
 *
 * If the list is empty, returns `[home]` (i.e. fresh-install fallback).
 */
export function withHomeFallback(list: readonly string[], home: string): string[] {
  if (list.length === 0) return [home];
  const lower = home.toLowerCase();
  if (list.some((p) => p.toLowerCase() === lower)) return [...list];
  return [...list, home];
}
