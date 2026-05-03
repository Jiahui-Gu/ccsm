// packages/daemon/src/crash/pruner.ts
//
// Crash retention pruner — sink (Task #64 / T5.12).
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch09 §3 (rotation and capping; pruner runs at boot and every 6h).
//   - ch07 §1 / §3 (`crash_log` schema + `better-sqlite3` wrapper).
//   - ch07 §5 (write-coalescing — pruner mutations are writer-side).
//   - ch02 §4 (graceful shutdown — caller's Shutdown ctx invokes `stop()`).
//
// SRP layering:
//   - **decider** — `decidePrune` in `pruner-decider.ts` (pure; this
//     module imports it).
//   - **producer** — the schedule (timer). Implemented here as
//     `defaultScheduler` so tests can swap `vi.useFakeTimers` via
//     dependency injection (`schedulerFactory`).
//   - **sink** — `CrashPruner.runOnce()` executes the decider's two
//     SQL statements inside a single IMMEDIATE transaction and emits
//     one log line per cycle.
//
// Boot wiring (see `index.ts`):
//   1. open db + run migrations + recovery + shutdown installation
//   2. construct `CrashPruner({ db, log, readSettings })`
//   3. call `pruner.start()` → 30s warmup, then first run, then 6h cadence.
//   4. register `pruner.stop` on the shutdown context.
//
// Layer 1 — alternatives checked:
//   - `node-cron` / `cron` packages: overkill (we have one job; no
//     crontab expressions). Adds a dep + parse step for what amounts to
//     `setTimeout` + `setInterval`. Rejected.
//   - Re-using a worker thread: pruning is two SQL statements inside
//     one IMMEDIATE transaction. The write coalescer (T5.6) already
//     serialises writers; running on the main thread in a 6h tick is
//     fine and avoids a worker-message round trip.
//   - Skipping the warmup: spec ch09 §3 only says "boot and every 6h".
//     The 30s warmup is a defence-in-depth knob from the task brief —
//     it keeps the pruner's first IMMEDIATE write off the boot critical
//     path (recovery, migration, listener bind all complete in <30s on
//     reference hardware).

import type { SqliteDatabase } from '../db/sqlite.js';

import {
  decidePrune,
  resolveRetention,
  type CrashRetentionSettings,
  type EffectiveRetention,
} from './pruner-decider.js';

/** Spec ch09 §3: pruner runs every 6h. */
export const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 30s startup warmup before the first prune run. The boot critical
 * path (recovery → migrations → listener bind) finishes well within
 * this on reference hardware; firing the pruner inside that window
 * would race the migration runner's IMMEDIATE transaction.
 */
export const STARTUP_WARMUP_MS = 30_000;

/** Per-cycle log payload. Surface-stable so tests can assert shape. */
export interface PruneCycleResult {
  readonly rowsDeletedAge: number;
  readonly rowsDeletedCount: number;
  readonly effective: EffectiveRetention;
  readonly elapsedMs: number;
}

/** Minimal log surface (matches the entrypoint's logger shape). */
export interface PrunerLogger {
  info(line: string): void;
  warn(line: string): void;
}

/**
 * Reads the current `Settings.crash_retention`. Wired in T5-Settings
 * later (Task #T5.x); v0.3 callers that don't yet have a SettingsRepo
 * pass a constant `() => ({})` and the decider falls back to defaults.
 */
export type ReadCrashRetention = () => CrashRetentionSettings;

/**
 * Schedule producer — exposed for test stubbing. Default impl wraps
 * `setTimeout` + `setInterval` (vitest's `useFakeTimers` swaps these
 * globally so tests don't need a custom scheduler in most cases).
 */
export interface PrunerScheduler {
  /** Schedule the first run after `delayMs`. Returns a canceller. */
  setTimeout(fn: () => void, delayMs: number): () => void;
  /** Schedule recurring runs every `periodMs`. Returns a canceller. */
  setInterval(fn: () => void, periodMs: number): () => void;
}

const defaultScheduler: PrunerScheduler = {
  setTimeout(fn, delayMs) {
    const t = setTimeout(fn, delayMs);
    // .unref() so the pruner timer alone never keeps the event loop
    // alive — listener-A and the supervisor own that responsibility.
    if (typeof t.unref === 'function') t.unref();
    return () => clearTimeout(t);
  },
  setInterval(fn, periodMs) {
    const t = setInterval(fn, periodMs);
    if (typeof t.unref === 'function') t.unref();
    return () => clearInterval(t);
  },
};

export interface CrashPrunerOptions {
  readonly db: SqliteDatabase;
  readonly log: PrunerLogger;
  /** Settings reader. Defaults to `() => ({})` (= use spec defaults). */
  readonly readSettings?: ReadCrashRetention;
  /** Clock injection for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Scheduler injection for tests. Defaults to global timers. */
  readonly scheduler?: PrunerScheduler;
  /** Override the 30s warmup (tests). */
  readonly warmupMs?: number;
  /** Override the 6h cadence (tests). */
  readonly intervalMs?: number;
}

/**
 * Crash retention pruner. Construct once per daemon boot; call `start()`
 * after migrations + recovery + Shutdown installation; call `stop()`
 * during graceful shutdown (T1.8 step ordering — between RPC drain and
 * WAL checkpoint is fine; the pruner is just a writer).
 *
 * Idempotent: a second `start()` is a no-op (warns); `stop()` after
 * `stop()` is a no-op.
 */
export class CrashPruner {
  private readonly db: SqliteDatabase;
  private readonly log: PrunerLogger;
  private readonly readSettings: ReadCrashRetention;
  private readonly now: () => number;
  private readonly scheduler: PrunerScheduler;
  private readonly warmupMs: number;
  private readonly intervalMs: number;

  private cancelWarmup: (() => void) | null = null;
  private cancelInterval: (() => void) | null = null;
  private started = false;
  private stopped = false;

  constructor(opts: CrashPrunerOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.readSettings = opts.readSettings ?? ((): CrashRetentionSettings => ({}));
    this.now = opts.now ?? ((): number => Date.now());
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.warmupMs = opts.warmupMs ?? STARTUP_WARMUP_MS;
    this.intervalMs = opts.intervalMs ?? PRUNE_INTERVAL_MS;
  }

  /**
   * Schedule the first run after `warmupMs`, then every `intervalMs`.
   * Safe to call once; calling again warns and is a no-op.
   */
  start(): void {
    if (this.started) {
      this.log.warn('crash-pruner: start() called twice; ignoring');
      return;
    }
    if (this.stopped) {
      this.log.warn('crash-pruner: start() after stop(); ignoring');
      return;
    }
    this.started = true;

    this.cancelWarmup = this.scheduler.setTimeout(() => {
      this.cancelWarmup = null;
      this.tick();
      // Install the steady-state cadence AFTER the first run completes
      // so a slow first run doesn't pile a second tick onto the same
      // event loop turn.
      this.cancelInterval = this.scheduler.setInterval(() => {
        this.tick();
      }, this.intervalMs);
    }, this.warmupMs);
  }

  /**
   * Cancel any pending timer. Idempotent. Does NOT run a final prune —
   * shutdown ordering hands the WAL checkpoint to T1.8 step 6 right
   * after this; running another prune here would race that.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.cancelWarmup !== null) {
      this.cancelWarmup();
      this.cancelWarmup = null;
    }
    if (this.cancelInterval !== null) {
      this.cancelInterval();
      this.cancelInterval = null;
    }
  }

  /**
   * Execute one prune cycle synchronously. Public so the entrypoint
   * (or tests) can force a prune outside the cadence. Captures and
   * logs all errors — never throws (the pruner must not crash the
   * daemon over a transient SQLite error).
   */
  runOnce(): PruneCycleResult | null {
    try {
      return this.runOnceInner();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`crash-pruner: cycle failed: ${msg}`);
      return null;
    }
  }

  private tick(): void {
    // tick() wraps runOnce() and is the only path the scheduler invokes.
    // Pulled out so a thrown timer callback can't bubble into the global
    // event loop (`runOnce` already swallows; this is belt + braces).
    this.runOnce();
  }

  private runOnceInner(): PruneCycleResult {
    const startedAt = this.now();
    const settings = this.readSettings();

    // Resolve early so we can warn ONCE per cycle if the user supplied
    // out-of-range values (matches the task brief: "emit warning log
    // on clamp").
    const eff = resolveRetention(settings);
    if (eff.maxEntriesClamped) {
      this.log.warn(
        `crash-pruner: max_entries clamped to hard cap ${eff.maxEntries} (user supplied higher)`,
      );
    }
    if (eff.maxAgeDaysClamped) {
      this.log.warn(
        `crash-pruner: max_age_days clamped to hard cap ${eff.maxAgeDays} (user supplied higher)`,
      );
    }

    const plan = decidePrune(startedAt, settings);
    const ageStmt = this.db.prepare(plan.ageDelete.sql);
    const countStmt = this.db.prepare(plan.countDelete.sql);

    // Single IMMEDIATE transaction (spec ch09 §3 + ch07 §5). The
    // wrapper from better-sqlite3's `db.transaction()` defaults to a
    // DEFERRED transaction; we want IMMEDIATE so the writer lock is
    // acquired before the age-pass DELETE so a concurrent reader
    // (CrashService.GetCrashLog) can't slip a stale snapshot between
    // the two passes.
    const tx = this.db.transaction((): { age: number; count: number } => {
      const age = ageStmt.run(plan.ageDelete.param).changes;
      const count = countStmt.run(plan.countDelete.param).changes;
      return { age, count };
    });
    // better-sqlite3: `.immediate()` requests `BEGIN IMMEDIATE`. The
    // wrapped fn takes no args, so the variadic `.immediate(...args)`
    // is invoked with none.
    const { age, count } = tx.immediate();

    const elapsedMs = this.now() - startedAt;
    this.log.info(
      `crash-pruner: rows_deleted_age=${age} rows_deleted_count=${count} ` +
        `max_entries=${eff.maxEntries} max_age_days=${eff.maxAgeDays} ` +
        `elapsed_ms=${elapsedMs}`,
    );
    return {
      rowsDeletedAge: age,
      rowsDeletedCount: count,
      effective: eff,
      elapsedMs,
    };
  }
}
