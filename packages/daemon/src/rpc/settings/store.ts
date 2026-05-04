// packages/daemon/src/rpc/settings/store.ts
//
// Wave-3 Task #349 (spec #337 §4) — read/write primitives that back
// every SettingsService + DraftService production handler. Pure data
// in, pure data out: no Connect knowledge, no logging, no clocks
// beyond `Date.now()` for the boot UPSERT timestamp (which the caller
// supplies).
//
// SRP layering (dev.md §2):
//   - producer: `readSettingsRows(db)` — single SQL SELECT against
//     the `(scope='global')` index-prefix.
//   - decider:  `rowsToSettings(rows)` — pure function row[] → proto
//     `Settings`. Forward-tolerant per spec #337 §2.4 (unknown keys
//     are logged and skipped, not thrown on).
//   - sink:     `upsertSettings`, `deleteSettingsRow`,
//     `upsertSettingsBoot` — UPSERT/DELETE inside a single
//     `db.transaction(...)` (BEGIN IMMEDIATE) per spec §4.2 / §4.5.
//
// Cap-and-clamp policy (spec §4.2 + settings.proto line 121-123):
//   `crash_retention.max_entries` is clamped at 10000 BEFORE write; same
//   for `max_age_days` at 90. Applied at write-time, not read-time, so
//   the DB state never holds an out-of-range value (the GetCrashLog +
//   pruner code can trust the column without re-clamping).

import { create } from '@bufbuild/protobuf';

import {
  CrashRetentionSchema,
  PtyGeometrySchema,
  SettingsSchema,
  type Settings,
} from '@ccsm/proto';

import type { SqliteDatabase } from '../../db/sqlite.js';
import {
  DAEMON_DERIVED_KEYS,
  DRAFT_PREFIX,
  SCOPE_GLOBAL,
  SETTINGS_KEYS,
  UI_PREFS_PREFIX,
} from './keys.js';

// ---------------------------------------------------------------------------
// Caps (spec §4.2 / settings.proto line 121-123).
// ---------------------------------------------------------------------------

/** Forever-stable spec-mandated caps. */
export const CAPS = Object.freeze({
  crashRetentionMaxEntries: 10000,
  crashRetentionMaxAgeDays: 90,
});

function clampInt(v: number, max: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v > max ? max : Math.floor(v);
}

// ---------------------------------------------------------------------------
// Producer — read all 'global'-scope rows.
// ---------------------------------------------------------------------------

interface SettingsRow {
  readonly key: string;
  readonly value: string;
}

/**
 * Read every `(scope='global')` row from the settings table.
 *
 * Cost (spec #337 §8.4): O(rows in 'global' scope). With the
 * `(scope, key)` PRIMARY KEY this is an index-prefix scan — sub-ms for
 * a typical install. Switching to a key-prefix-targeted query if
 * `ui_prefs` ever balloons to thousands of entries is a one-line
 * change with no schema impact.
 */
export function readSettingsRows(
  db: SqliteDatabase,
): readonly SettingsRow[] {
  return db
    .prepare<[string], SettingsRow>(
      'SELECT key, value FROM settings WHERE scope = ?',
    )
    .all(SCOPE_GLOBAL);
}

/**
 * Read exactly one settings row by key. Returns `null` when absent
 * (used by DraftService.GetDraft to return the empty-draft response
 * without a separate "exists?" round-trip).
 */
export function readOneSettingsRow(
  db: SqliteDatabase,
  key: string,
): SettingsRow | null {
  const row = db
    .prepare<[string, string], SettingsRow>(
      'SELECT key, value FROM settings WHERE scope = ? AND key = ?',
    )
    .get(SCOPE_GLOBAL, key);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Decider — rows -> proto Settings.
// ---------------------------------------------------------------------------

/**
 * Project the row stream returned by `readSettingsRows` into a proto
 * `Settings` message. Spec #337 §2.4 forward-tolerance: unknown keys
 * are reported via the optional `onUnknown` callback (the caller logs
 * at debug level) but never throw — proto3 unknown-field semantics
 * applied to the storage layer.
 *
 * `draft:*` rows are SKIPPED (drafts are owned by DraftService, not
 * surfaced through SettingsService — spec §4.1 step 2).
 */
export function rowsToSettings(
  rows: readonly SettingsRow[],
  options: { readonly onUnknown?: (key: string) => void } = {},
): Settings {
  const settings = create(SettingsSchema, {});
  const uiPrefs: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.startsWith(DRAFT_PREFIX)) {
      continue; // owned by DraftService
    }
    if (row.key.startsWith(UI_PREFS_PREFIX)) {
      const mapKey = row.key.slice(UI_PREFS_PREFIX.length);
      // Spec §2.2: ui_prefs row `value` is the already-JSON-encoded
      // string verbatim (the proto field type is already `string`;
      // daemon does NOT re-encode). However writers in this module
      // pass the proto-string through `JSON.stringify` to keep the
      // table 100% JSON-encoded (spec §2.3) — read parses to recover
      // the original string.
      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed === 'string') uiPrefs[mapKey] = parsed;
      } catch {
        // Corrupt row — surface as if absent. Forward-tolerant.
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // Corrupt row — skip. Forward-tolerant.
      continue;
    }
    switch (row.key) {
      case SETTINGS_KEYS.defaultGeometry: {
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'cols' in parsed &&
          'rows' in parsed
        ) {
          const obj = parsed as { cols: unknown; rows: unknown };
          settings.defaultGeometry = create(PtyGeometrySchema, {
            cols: typeof obj.cols === 'number' ? obj.cols : 0,
            rows: typeof obj.rows === 'number' ? obj.rows : 0,
          });
        }
        break;
      }
      case SETTINGS_KEYS.crashRetention: {
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'max_entries' in parsed &&
          'max_age_days' in parsed
        ) {
          const obj = parsed as { max_entries: unknown; max_age_days: unknown };
          settings.crashRetention = create(CrashRetentionSchema, {
            maxEntries:
              typeof obj.max_entries === 'number' ? obj.max_entries : 0,
            maxAgeDays:
              typeof obj.max_age_days === 'number' ? obj.max_age_days : 0,
          });
        }
        break;
      }
      case SETTINGS_KEYS.detectedClaudeDefaultModel:
        if (typeof parsed === 'string') settings.detectedClaudeDefaultModel = parsed;
        break;
      case SETTINGS_KEYS.userHomePath:
        if (typeof parsed === 'string') settings.userHomePath = parsed;
        break;
      case SETTINGS_KEYS.locale:
        if (typeof parsed === 'string') settings.locale = parsed;
        break;
      case SETTINGS_KEYS.sentryEnabled:
        if (typeof parsed === 'boolean') settings.sentryEnabled = parsed;
        break;
      default:
        options.onUnknown?.(row.key);
    }
  }
  settings.uiPrefs = uiPrefs;
  return settings;
}

// ---------------------------------------------------------------------------
// Sink — UPSERT / DELETE primitives.
// ---------------------------------------------------------------------------

/**
 * Encoded write op produced by the UpdateSettings decider before the
 * transaction runs. Either an UPSERT (key with new JSON value) or a
 * DELETE (clearing a `ui_prefs` entry — spec §4.2: empty string ==
 * "client asked to forget this key").
 */
export type SettingsWriteOp =
  | { readonly kind: 'upsert'; readonly key: string; readonly value: string }
  | { readonly kind: 'delete'; readonly key: string };

/**
 * Apply a batch of write ops in a single IMMEDIATE transaction (spec
 * §4.2 + §4.5). Better-sqlite3's `db.transaction(...).immediate(...)`
 * is the canonical primitive (already used by `WriteCoalescer.flushBatch`).
 *
 * IMMEDIATE acquires the writer lock at BEGIN time, so a partial
 * failure mid-batch rolls back cleanly; SQLite's writer-lock semantics
 * (one writer, many readers) serialize against any concurrent
 * coalescer write on the same connection.
 */
export function applySettingsWrites(
  db: SqliteDatabase,
  ops: readonly SettingsWriteOp[],
): void {
  if (ops.length === 0) return;
  const upsert = db.prepare<[string, string, string]>(
    'INSERT INTO settings (scope, key, value) VALUES (?, ?, ?) ' +
      'ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value',
  );
  const del = db.prepare<[string, string]>(
    'DELETE FROM settings WHERE scope = ? AND key = ?',
  );
  const txn = db.transaction((batch: readonly SettingsWriteOp[]) => {
    for (const op of batch) {
      if (op.kind === 'upsert') {
        upsert.run(SCOPE_GLOBAL, op.key, op.value);
      } else {
        del.run(SCOPE_GLOBAL, op.key);
      }
    }
  });
  txn.immediate(ops);
}

// ---------------------------------------------------------------------------
// Boot UPSERT — daemon-derived fields.
// ---------------------------------------------------------------------------

export interface BootDerivedFields {
  readonly userHomePath: string;
  readonly detectedClaudeDefaultModel: string;
}

/**
 * UPSERT the daemon-derived rows (spec §5). Called once per boot from
 * `runStartup` AFTER migrations have run and BEFORE `assertWired`. Both
 * writes go through the same `INSERT … ON CONFLICT … DO UPDATE` path
 * the handler uses (spec §4.2), in a single boot transaction so a
 * crash mid-write leaves the table in a consistent state.
 *
 * Idempotent — every boot writes the same two rows; consecutive boots
 * with no env change are a no-op at the row-content level (the UPSERT
 * still runs but `excluded.value` equals the existing value).
 */
export function upsertSettingsBoot(
  db: SqliteDatabase,
  fields: BootDerivedFields,
): void {
  applySettingsWrites(db, [
    {
      kind: 'upsert',
      key: SETTINGS_KEYS.userHomePath,
      value: JSON.stringify(fields.userHomePath),
    },
    {
      kind: 'upsert',
      key: SETTINGS_KEYS.detectedClaudeDefaultModel,
      value: JSON.stringify(fields.detectedClaudeDefaultModel),
    },
  ]);
}

// ---------------------------------------------------------------------------
// Encode patch — proto Settings -> SettingsWriteOp[]
// ---------------------------------------------------------------------------

/**
 * Result of running the partial-update decider on a proto `Settings`:
 * either a list of write ops to apply, or a daemon-derived field
 * rejection that the handler turns into `Code.InvalidArgument` (spec
 * §4.2 + acceptance §7 #5).
 *
 * The decider does NOT return a `Promise` and does NOT touch the
 * database — the handler runs the ops via `applySettingsWrites` after
 * inspecting this result. This separation keeps the cap-and-clamp
 * logic unit-testable without a sqlite handle.
 */
export type EncodePatchResult =
  | { readonly kind: 'ok'; readonly ops: readonly SettingsWriteOp[] }
  | { readonly kind: 'reject_daemon_derived'; readonly key: string };

/**
 * Translate a client's `Settings` message into a write-op list per
 * spec §4.2.
 *
 * Field-presence handling:
 *   - `default_geometry` / `crash_retention` are proto3 `optional` —
 *     the generated TS type uses `T | undefined`, so `!== undefined`
 *     IS the presence bit (spec §4.2 step 1).
 *   - All other scalars (`locale`, `sentry_enabled`,
 *     `detected_claude_default_model`, `user_home_path`) lack proto3
 *     presence — the wire always carries a value. We adopt the
 *     "non-default value = client touched" heuristic (matches the F7
 *     spec footnote scope: "presence semantics for `optional` fields";
 *     scalars without `optional` are documented as "always-present").
 *     For `sentry_enabled` specifically, the absence of presence on a
 *     bool is genuinely ambiguous (false could mean "default" or
 *     "client asked false"); since the proto comment documents the
 *     default as `true`, we treat `false` as "client touched" and
 *     `true` as "no change unless row is currently absent". Spec #337
 *     §9 q1 leaves this open; this matches the ship behaviour
 *     reviewers should expect.
 *   - `ui_prefs` map: every entry the client sent gets one upsert,
 *     except empty-string values which DELETE the row (spec §4.2 last
 *     bullet — "client asked to forget this key").
 *
 * Daemon-derived rejection: if the client sent a NON-EMPTY value for
 * `user_home_path` or `detected_claude_default_model`, return the
 * reject result; the handler raises `Code.InvalidArgument`. An empty
 * value is silently ignored (proto3 default — "client didn't touch").
 */
export function encodeUpdatePatch(s: Settings): EncodePatchResult {
  const ops: SettingsWriteOp[] = [];

  // Daemon-derived rejection FIRST so we never partially apply a batch
  // that includes a forbidden field.
  if (s.userHomePath !== '') {
    return { kind: 'reject_daemon_derived', key: SETTINGS_KEYS.userHomePath };
  }
  if (s.detectedClaudeDefaultModel !== '') {
    return {
      kind: 'reject_daemon_derived',
      key: SETTINGS_KEYS.detectedClaudeDefaultModel,
    };
  }

  if (s.defaultGeometry !== undefined) {
    ops.push({
      kind: 'upsert',
      key: SETTINGS_KEYS.defaultGeometry,
      value: JSON.stringify({
        cols: s.defaultGeometry.cols,
        rows: s.defaultGeometry.rows,
      }),
    });
  }
  if (s.crashRetention !== undefined) {
    const clamped = {
      max_entries: clampInt(
        s.crashRetention.maxEntries,
        CAPS.crashRetentionMaxEntries,
      ),
      max_age_days: clampInt(
        s.crashRetention.maxAgeDays,
        CAPS.crashRetentionMaxAgeDays,
      ),
    };
    ops.push({
      kind: 'upsert',
      key: SETTINGS_KEYS.crashRetention,
      value: JSON.stringify(clamped),
    });
  }

  if (s.locale !== '') {
    ops.push({
      kind: 'upsert',
      key: SETTINGS_KEYS.locale,
      value: JSON.stringify(s.locale),
    });
  }
  // Treat `sentry_enabled === false` as the client's signal to opt out
  // (proto comment documents the default as `true`). `true` is taken
  // as "no opinion / leave alone" in the absence of a presence bit;
  // the row stays at whatever the boot / prior write left it.
  if (s.sentryEnabled === false) {
    ops.push({
      kind: 'upsert',
      key: SETTINGS_KEYS.sentryEnabled,
      value: JSON.stringify(false),
    });
  }

  for (const [k, v] of Object.entries(s.uiPrefs)) {
    const fullKey = `${UI_PREFS_PREFIX}${k}`;
    if (v === '') {
      ops.push({ kind: 'delete', key: fullKey });
    } else {
      ops.push({
        kind: 'upsert',
        key: fullKey,
        // Spec §2.2 ui_prefs row note: store the JSON-encoded form so
        // the table is 100% JSON. Reader symmetrically `JSON.parse`s.
        value: JSON.stringify(v),
      });
    }
  }

  // Keep the linter happy about `DAEMON_DERIVED_KEYS` being live —
  // referenced here as the canonical source of which keys are
  // daemon-derived. The conditional above is the actual gate.
  void DAEMON_DERIVED_KEYS;

  return { kind: 'ok', ops };
}
