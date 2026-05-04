// packages/daemon/src/rpc/settings/keys.ts
//
// Wave-3 Task #349 (spec #337 §2 / §4) — canonical (scope, key) row
// vocabulary for the v0.3 SettingsService + DraftService production
// handlers.
//
// FOREVER-STABLE per spec #337 §2.4 ("Reserved key namespace prefixes").
// These strings are written into the on-disk `settings` table on every
// boot; renaming any of them in a v0.3.x patch silently orphans the rows
// from prior installs. v0.4 is allowed to ADD new keys / new prefixes
// here additively but MUST NOT rename or remove any existing entry.
//
// Every `value` column entry is JSON-encoded (spec #337 §2.3) — readers
// `JSON.parse(value)`, writers `JSON.stringify(value)`. The single
// uniform parse path avoids the "did someone JSON.stringify a string
// twice" class of bugs and matches the proto-to-storage codec discipline
// used elsewhere (`env_json` / `claude_args_json` in the `sessions`
// table).
//
// SRP: pure constants — no I/O, no logic. Imported by every handler
// + the boot UPSERT path so the row vocabulary lives in exactly one
// file.

/** Forever-stable v0.3 scope literal (spec #337 §2.2). */
export const SCOPE_GLOBAL = 'global';

/**
 * Canonical typed-scalar / message-typed key strings. One row per entry
 * in the `settings` table when present (UPSERT semantics).
 */
export const SETTINGS_KEYS = {
  defaultGeometry: 'default_geometry',
  crashRetention: 'crash_retention',
  detectedClaudeDefaultModel: 'detected_claude_default_model',
  userHomePath: 'user_home_path',
  locale: 'locale',
  sentryEnabled: 'sentry_enabled',
} as const;

/**
 * Daemon-derived keys — set by the boot path (spec #337 §5) and rejected
 * with `Code.InvalidArgument` if a client tries to write them via
 * UpdateSettings (spec #337 §4.2 + acceptance §7 #5).
 *
 * `Set` not `ReadonlyArray` so the handler can do `.has(key)` without
 * scanning.
 */
export const DAEMON_DERIVED_KEYS: ReadonlySet<string> = new Set([
  SETTINGS_KEYS.detectedClaudeDefaultModel,
  SETTINGS_KEYS.userHomePath,
]);

/**
 * Prefix that identifies a `Settings.ui_prefs` map entry row in the
 * settings table. Spec #337 §2.2: the GetSettings handler reconstructs
 * the proto map by filtering rows whose `key` starts with this prefix
 * and slicing the prefix off.
 *
 * The trailing dot is the boundary — `ui_prefs.appearance.theme` →
 * map key `appearance.theme`. A row whose key starts with
 * `ui_prefs.draft:` is unambiguous (it's a ui_prefs entry literally
 * named `draft:foo`) because draft rows live under the bare `draft:`
 * prefix without `ui_prefs.` in front (spec #337 §9 q6).
 */
export const UI_PREFS_PREFIX = 'ui_prefs.';

/**
 * Prefix that identifies a per-session draft row in the settings table.
 * Spec #337 §2.2 + draft.proto line 8. Key shape is `draft:<session_id>`.
 *
 * GetSettings SKIPS these rows (drafts are owned by DraftService, not
 * exposed via Settings). DraftService.GetDraft / UpdateDraft target
 * exactly one row each by full key.
 */
export const DRAFT_PREFIX = 'draft:';

/**
 * Build the full `draft:<session_id>` storage key. Centralised so a
 * future change (e.g. adding a `v2:` segment for v0.4 backward-incompat
 * draft format) lands in exactly one place — the spec §2.4 reservation
 * is on the `draft:` prefix, not on the rest of the key.
 */
export function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

/**
 * ULID format guard for `session_id`. Spec #337 §8.3: defence-in-depth
 * — better-sqlite3 parameter binding already prevents SQL injection,
 * but rejecting malformed ids early keeps the storage table free of
 * garbage rows (and surfaces the bug at the wire boundary instead of
 * later).
 */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
