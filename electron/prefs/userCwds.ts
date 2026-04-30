// User-owned cwd LRU. Consolidates the pure decider helpers from the prior
// `electron/userCwds.ts` module with the I/O wrappers (`getUserCwds`,
// `pushUserCwd`) extracted from `electron/main.ts` (Task #730 Phase A1).
//
// The new-session default cwd is the LRU head (the user's most-recently
// picked cwd) when present, falling back to `os.homedir()` when the LRU is
// empty (fresh install). The recent list shown in the StatusBar cwd popover
// is a user-owned LRU that only the user can extend (by explicitly picking a
// non-default cwd). Persisted in the `app_state` SQLite table under key
// `userCwds` as a JSON string list.
//
// Reads return `[homedir()]` when the list is empty so the popover always has
// at least the home entry. Writes are LRU (newest first) with case-
// insensitive path-normalised dedupe and a hard cap of 20 entries.
//
// Producer/decider/sink split:
//   - SQLite app_state row is the producer of the raw list (readUserCwds)
//   - the pure helpers below decide the next list (decider — no I/O)
//   - writeUserCwds is the sink (saveState side-effect)

import * as os from 'os';
import { loadState, saveState } from '../db';

export const USER_CWDS_KEY = 'userCwds';
export const USER_CWDS_MAX = 20;

// ─────────────────────── pure helpers (deciders) ─────────────────────────

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
export function pushLRU(list: readonly string[], item: string, max = USER_CWDS_MAX): string[] {
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

// ─────────────────────── I/O wrappers ────────────────────────────────────

function readUserCwds(): string[] {
  try {
    const raw = loadState(USER_CWDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && !!p);
  } catch {
    return [];
  }
}

function writeUserCwds(list: string[]): void {
  try {
    saveState(USER_CWDS_KEY, JSON.stringify(list.slice(0, USER_CWDS_MAX)));
  } catch (err) {
    console.warn('[main] writeUserCwds failed', err);
  }
}

export function getUserCwds(): string[] {
  return withHomeFallback(readUserCwds(), os.homedir());
}

export function pushUserCwd(p: string): string[] {
  const norm = normalizeCwd(p);
  if (!norm) return readUserCwds();
  const next = pushLRU(readUserCwds(), norm, USER_CWDS_MAX);
  writeUserCwds(next);
  return next;
}
