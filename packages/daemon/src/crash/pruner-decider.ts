// packages/daemon/src/crash/pruner-decider.ts
//
// Pure decider for the crash retention pruner (Task #64 / T5.12).
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch09 §3 (rotation and capping):
//       - Cap on entry count: default 10000 rows; exceeding → delete oldest by `ts_ms`.
//       - Cap on age: default 90 days; exceeding → delete by `ts_ms < now - 90d`.
//       - Both caps configurable via `Settings.crash_retention`; daemon
//         enforces hard caps `max_entries ≤ 10000`, `max_age_days ≤ 90`.
//       - Pruner runs at boot and every 6 hours.
//   - ch07 §3 (`crash_log` schema; column `ts_ms`).
//
// SRP: this module is the **decider**. It is a pure function:
//   `decidePrune(now, settings, stats) → PrunePlan`
// No DB I/O, no clock, no logging. The sink (`pruner.ts`) supplies `now`
// and `stats`, executes the SQL the plan emits, and writes the log line.
//
// Layer 1 — alternatives checked:
//   - A single SQL `DELETE FROM crash_log WHERE ts_ms < ? OR id IN (...)`
//     would conflate the two prune passes. We keep them separate so:
//       (a) the log line cleanly attributes rows_deleted_age vs.
//           rows_deleted_count (operators triaging "why is the log
//           shrinking" need this distinction);
//       (b) the count-cap pass operates on the post-age-cap row count,
//           matching the spec's natural reading ("delete oldest beyond
//           max_entries" is meaningful only after age-pruning).
//   - Reading the cap defaults from a separate constants module: the
//     hard caps ARE the defaults per spec ch09 §3 ("default 10000 /
//     default 90"; "daemon enforces hard caps max_entries ≤ 10000,
//     max_age_days ≤ 90"). Same value, single source of truth.

/**
 * Hard cap on `crash_log` row count. Spec ch09 §3.
 * The DEFAULT and the HARD CAP are the same value per spec: a
 * user-supplied value above this is silently clamped.
 */
export const MAX_ENTRIES_HARD_CAP = 10_000;

/**
 * Hard cap on `crash_log` row age in days. Spec ch09 §3. As above:
 * default == hard cap; user-supplied above this is silently clamped.
 */
export const MAX_AGE_DAYS_HARD_CAP = 90;

/** Milliseconds in a day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** User-supplied retention settings (sourced from `Settings.crash_retention`). */
export interface CrashRetentionSettings {
  /**
   * Max retained rows. Undefined / non-positive / NaN → use the default
   * (== hard cap). Values above the hard cap are silently clamped to it
   * (with a warning emitted by the sink); the decider returns the
   * clamped value in `effective` so the sink can log it.
   */
  readonly max_entries?: number;
  /**
   * Max retained age in days. Same defaulting + clamping rules as
   * `max_entries`.
   */
  readonly max_age_days?: number;
}

/** Effective (post-defaulting, post-clamping) retention settings. */
export interface EffectiveRetention {
  readonly maxEntries: number;
  readonly maxAgeDays: number;
  /** True if the caller's `max_entries` was clamped down. */
  readonly maxEntriesClamped: boolean;
  /** True if the caller's `max_age_days` was clamped down. */
  readonly maxAgeDaysClamped: boolean;
}

/**
 * Resolve user-supplied settings into the effective values the pruner
 * acts on. Pure function; no I/O. Exposed so the sink can log a single
 * "settings clamped" warning at the start of each cycle.
 */
export function resolveRetention(s: CrashRetentionSettings): EffectiveRetention {
  const me = clampPositive(s.max_entries, MAX_ENTRIES_HARD_CAP);
  const md = clampPositive(s.max_age_days, MAX_AGE_DAYS_HARD_CAP);
  return {
    maxEntries: me.value,
    maxAgeDays: md.value,
    maxEntriesClamped: me.clamped,
    maxAgeDaysClamped: md.clamped,
  };
}

function clampPositive(
  raw: number | undefined,
  hardCap: number,
): { value: number; clamped: boolean } {
  // Undefined, non-finite, NaN, zero, or negative → fall back to default
  // (== hard cap). Spec phrases the defaults as "default 10000 / default
  // 90"; missing-or-bogus user input collapses to the same value.
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return { value: hardCap, clamped: false };
  }
  // SQLite ts_ms is an integer; round down a fractional max_age_days so
  // the threshold maths stays in integer ms without truncation surprises.
  const v = Math.floor(raw);
  if (v > hardCap) {
    return { value: hardCap, clamped: true };
  }
  return { value: v, clamped: false };
}

/**
 * The two parameterised SQL statements that comprise one prune cycle.
 * Each is a single statement with a single bound parameter. The sink
 * runs both inside one `IMMEDIATE` transaction (spec ch09 §3 + ch07 §5
 * write-coalescing: prune work is a writer-side concern).
 *
 * `ageDelete`     — delete rows older than `now - maxAgeDays * 86400000`.
 * `countDelete`   — keep newest `maxEntries`; delete the rest by `ts_ms`.
 *
 * Note: both statements target `crash_log`. The table lives in
 * `001_initial.sql` (T5.2 / Task #55) with column `ts_ms` (per spec
 * ch07 §3).
 */
export interface PrunePlan {
  readonly ageDelete: { readonly sql: string; readonly param: number };
  readonly countDelete: { readonly sql: string; readonly param: number };
  readonly effective: EffectiveRetention;
  /** Cut-off in epoch ms (`now - maxAgeDays * 86400000`). Mirrored here
   *  so tests can assert without re-deriving it from `now`. */
  readonly ageCutoffMs: number;
}

/**
 * Build the prune plan. Pure: same `(now, settings)` always yields the
 * same SQL + params. The sink supplies a real `Date.now()` (or a fake
 * clock under `vi.useFakeTimers`).
 *
 * The two statements are intentionally string-templated with the param
 * separated: the sink uses `db.prepare(sql).run(param)` so SQLite still
 * binds the value (no string-concat injection — `param` is always a
 * number anyway, but the contract keeps prepared-statement caching
 * intact).
 */
export function decidePrune(
  now: number,
  settings: CrashRetentionSettings,
): PrunePlan {
  const eff = resolveRetention(settings);
  const ageCutoffMs = now - eff.maxAgeDays * MS_PER_DAY;
  return {
    ageDelete: {
      sql: 'DELETE FROM crash_log WHERE ts_ms < ?',
      param: ageCutoffMs,
    },
    countDelete: {
      // Keep the newest `maxEntries` rows by ts_ms (tie-broken by id so
      // the result is deterministic when many rows share a timestamp).
      // We delete the complement: rows whose id is NOT in the top-N.
      sql:
        'DELETE FROM crash_log WHERE id NOT IN (' +
        'SELECT id FROM crash_log ORDER BY ts_ms DESC, id DESC LIMIT ?' +
        ')',
      param: eff.maxEntries,
    },
    effective: eff,
    ageCutoffMs,
  };
}
