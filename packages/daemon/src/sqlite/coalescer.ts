// packages/daemon/src/sqlite/coalescer.ts
//
// Per-session SQLite write coalescer for the daemon main process.
// Implements ch07 §5 of
//   docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//
// Topology (FOREVER-STABLE per spec):
//   - One pty-host child process per session `postMessage`s deltas to the
//     daemon main thread (this module is the receiving end).
//   - Per-session hand-rolled `setTimeout(tickMs)` batcher accumulates
//     enqueued deltas inside a 16 ms window. All deltas that arrive
//     inside the window are flushed as one prepared-statement loop
//     wrapped in a single SQLite IMMEDIATE transaction.
//
//     Why hand-rolled (replaces `better-queue` per Task #184): on Windows
//     `better-queue` schedules its worker via a cascade
//     `push → setTimeout(0) → setTimeout(batchDelay) → setImmediate` that
//     adds 24-31 ms minimum on top of the configured batch delay (15.625 ms
//     timer granularity). Under CI load on `windows-latest` this exceeds
//     the test margin (`coalescer.spec.ts` 56 ms slack). Spec ch07 §5
//     mandates an exact 16 ms tick + IMMEDIATE txn — the simplest scheduler
//     that honors that on every platform is one `setTimeout(tickMs)` per
//     session. The FOREVER-STABLE invariants ((a) 16 ms tick, (b) batched
//     IMMEDIATE txn per session, (c) 8 MiB per-session cap, (d) 3-strike
//     DEGRADED) are preserved; only the scheduler implementation changed.
//   - Per-session pending-byte cap of 8 MiB. On overflow the enqueue call
//     throws a Connect `ResourceExhausted` error so the caller (the
//     pty-host bridge) can drop the snapshot/delta and write a
//     `crash_log source = "sqlite_queue_overflow"` row (out of scope for
//     this module — see chapter 04 §5).
//   - On 3 consecutive disk-class write failures for the same session,
//     the session is marked DEGRADED and a `session-degraded` event is
//     emitted on the coalescer. Subsequent successful writes reset the
//     counter and emit `session-recovered`. Live deltas continue to
//     stream from the in-memory ring (chapter 06 §4 — not this module's
//     concern); the coalescer's job is only to (a) survive the I/O
//     failure without crashing the daemon, (b) signal DEGRADED so the
//     PtyService Connect handler can flip the session-state enum.
//
// SRP:
//   - producer side: `enqueueDelta` / `enqueueSnapshot` accept typed
//     payloads from the pty-host bridge.
//   - sink side: `flushBatch` runs the IMMEDIATE transaction.
//   - decider side: `classifyError` (pure) maps a thrown error to
//     `is-disk-class` boolean using the SQLite error-code list from the
//     spec (`SQLITE_FULL` / `SQLITE_IOERR` / `SQLITE_READONLY`).
//
// Re-uses `openDatabase` / `SqliteDatabase` from the existing wrapper at
// `../db/sqlite.ts` (T5.1 / Task #54). This module does NOT open the
// connection itself — callers pass an already-PRAGMA'd handle in.

import { EventEmitter } from 'node:events';

import { Code, ConnectError } from '@connectrpc/connect';

import type { SqliteDatabase } from '../db/sqlite.js';

// ---------------------------------------------------------------------------
// Spec-derived constants (ch07 §5). Frozen so tests can assert against the
// same values the runtime applies.
// ---------------------------------------------------------------------------

/** 16 ms tick window — matches chapter 06 §3 delta segmentation cadence. */
export const TICK_MS = 16;

/** Per-session pending-byte cap before `RESOURCE_EXHAUSTED` (ch07 §5). */
export const QUEUE_CAP_BYTES = 8 * 1024 * 1024; // 8 MiB

/** Consecutive write failures before a session transitions to DEGRADED. */
export const DEGRADED_FAILURE_THRESHOLD = 3;

/** SQLite error codes that count as disk-class failures (ch07 §5). */
const DISK_CLASS_CODES = new Set<string>([
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_IOERR_WRITE',
  'SQLITE_IOERR_FSYNC',
  'SQLITE_IOERR_DIR_FSYNC',
  'SQLITE_IOERR_TRUNCATE',
  'SQLITE_IOERR_DELETE',
  'SQLITE_IOERR_SHORT_READ',
  'SQLITE_READONLY',
  'SQLITE_READONLY_DBMOVED',
  'SQLITE_READONLY_DIRECTORY',
]);

// ---------------------------------------------------------------------------
// Public payload shapes. Kept narrow; the wider snapshot/delta envelope
// (chapter 06 §2/§3) lives in `pty-host/types.ts` — this module only sees
// the fields it needs to write the row.
// ---------------------------------------------------------------------------

/** A pty-host-produced delta destined for the `pty_delta` table. */
export interface DeltaWrite {
  readonly kind: 'delta';
  readonly sessionId: string;
  readonly seq: number;
  /** Raw VT bytes (chapter 06 §3). */
  readonly payload: Uint8Array;
  readonly tsMs: number;
}

/** A pty-host-produced snapshot destined for the `pty_snapshot` table. */
export interface SnapshotWrite {
  readonly kind: 'snapshot';
  readonly sessionId: string;
  readonly baseSeq: number;
  /** SnapshotV1 schema_version (chapter 06 §2; v0.3 always 1). */
  readonly schemaVersion: number;
  readonly geometryCols: number;
  readonly geometryRows: number;
  /** Encoded SnapshotV1 bytes (chapter 06 §2). */
  readonly payload: Uint8Array;
  readonly createdMs: number;
}

export type CoalescerWrite = DeltaWrite | SnapshotWrite;

/** Health states a session can be in from the coalescer's perspective. */
export type SessionHealth = 'healthy' | 'degraded';

// ---------------------------------------------------------------------------
// Internal per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  /** In-memory queue of pending writes awaiting the next tick flush. */
  pendingWrites: DeltaWrite[];
  /** Pending bytes already accepted into the queue (for the 8 MiB cap). */
  pendingBytes: number;
  /** Active flush-tick timer; null when no tick is scheduled. */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** True while `flushBatch` is on the stack — gate against re-entry. */
  flushing: boolean;
  /**
   * Resolvers waiting for the in-flight (or scheduled) flush to complete.
   * Used by `destroy()` to await graceful drain. Cleared after each
   * successful flush; `enqueueDelta` re-arms a new wait if needed.
   */
  drainWaiters: Array<() => void>;
  /** Consecutive disk-class failures for this session. */
  consecutiveFailures: number;
  /** Current health state — flipped on the 3rd consecutive failure. */
  health: SessionHealth;
}

// ---------------------------------------------------------------------------
// Coalescer
// ---------------------------------------------------------------------------

export interface WriteCoalescerOptions {
  /**
   * The DB handle returned by `openDatabase()` (T5.1). The coalescer does
   * NOT manage the connection lifecycle — the caller owns
   * `db.close()` at shutdown (T5.6 will drive the WAL-truncate checkpoint).
   */
  readonly db: SqliteDatabase;
  /**
   * Override the tick window. Test-only — production always uses
   * `TICK_MS`. Bounded `[1, 1000]` to catch fat-finger overrides.
   */
  readonly tickMs?: number;
  /**
   * Override the queue cap. Test-only — production always uses
   * `QUEUE_CAP_BYTES`. Bounded `[1, QUEUE_CAP_BYTES]`.
   */
  readonly queueCapBytes?: number;
}

/**
 * Events emitted by the coalescer. The PtyService Connect handler (T4.x)
 * subscribes to flip the session-state enum returned to subscribers; the
 * crash-capture sink (T9.x) subscribes to write `crash_log` rows. Neither
 * of those wirings is in scope for T5.5 — this module only emits.
 *
 * Typed listener signatures are documented here; callers should pass
 * listeners matching these shapes. We do NOT use a declaration-merged
 * EventEmitter interface (eslint @typescript-eslint/no-unsafe-declaration-merging
 * forbids it) — `EventEmitter`'s native `on` signature accepts any
 * listener and the type-safety here is by-convention.
 */
export type WriteCoalescerEvents = {
  'session-degraded': (sessionId: string, lastError: Error) => void;
  'session-recovered': (sessionId: string) => void;
  'write-failed': (
    sessionId: string,
    table: 'pty_delta' | 'pty_snapshot',
    err: Error,
  ) => void;
};

export class WriteCoalescer extends EventEmitter {
  private readonly db: SqliteDatabase;
  private readonly tickMs: number;
  private readonly queueCapBytes: number;
  private readonly sessions = new Map<string, SessionState>();
  /** Prepared once per coalescer; reused across every flush. */
  private readonly insertDelta;
  private readonly insertSnapshot;
  private destroyed = false;

  constructor(options: WriteCoalescerOptions) {
    super();
    this.db = options.db;
    this.tickMs = clampOverride(options.tickMs ?? TICK_MS, 1, 1000, 'tickMs');
    this.queueCapBytes = clampOverride(
      options.queueCapBytes ?? QUEUE_CAP_BYTES,
      1,
      QUEUE_CAP_BYTES,
      'queueCapBytes',
    );

    // Schemas: chapter 07 §3 / 001_initial.sql
    //   pty_delta(session_id, seq, payload, ts_ms)   PK (session_id, seq)
    //   pty_snapshot(session_id, base_seq, bytes, ts_ms, ...)
    //
    // Snapshot row shape isn't fully frozen across migrations beyond the
    // four columns the coalescer touches. We deliberately INSERT only the
    // four-column subset; later migrations adding nullable columns stay
    // additive.
    this.insertDelta = this.db.prepare(
      'INSERT INTO pty_delta (session_id, seq, payload, ts_ms) VALUES (?, ?, ?, ?)',
    );
    this.insertSnapshot = this.db.prepare(
      'INSERT INTO pty_snapshot ' +
        '(session_id, base_seq, schema_version, geometry_cols, geometry_rows, payload, created_ms) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
  }

  /**
   * Enqueue a delta for batched write. Returns synchronously after the
   * payload is accepted into the per-session pending queue; the actual
   * SQLite write happens on the next 16 ms tick.
   *
   * Throws `ConnectError(RESOURCE_EXHAUSTED)` if the session's pending
   * byte total would exceed the 8 MiB cap. The pty-host bridge is
   * expected to catch this and write the `sqlite_queue_overflow`
   * crash_log row (out of scope here).
   */
  enqueueDelta(write: DeltaWrite): void {
    this.assertNotDestroyed();
    const state = this.getOrCreateSession(write.sessionId);
    const size = write.payload.byteLength;
    if (state.pendingBytes + size > this.queueCapBytes) {
      throw new ConnectError(
        `write coalescer queue cap exceeded for session ${write.sessionId} ` +
          `(pending=${state.pendingBytes} + incoming=${size} > cap=${this.queueCapBytes})`,
        Code.ResourceExhausted,
      );
    }
    state.pendingBytes += size;
    state.pendingWrites.push(write);
    this.armFlushTimer(write.sessionId, state);
  }

  /**
   * Snapshot writes are out-of-band per spec ch07 §5: own transaction,
   * runs synchronously NOT through the delta queue. We still funnel the
   * disk-class failure handling through the same `consecutiveFailures`
   * counter so a flaky disk degrades the session whether the trigger was
   * a delta batch or a snapshot.
   *
   * Synchronous return so the caller can decide what to do on success
   * vs. failure (snapshot generation is rare; the pty-host child caches
   * the bytes in its in-memory ring whether or not the write lands).
   */
  enqueueSnapshot(write: SnapshotWrite): void {
    this.assertNotDestroyed();
    const state = this.getOrCreateSession(write.sessionId);
    try {
      const txn = this.db.transaction((s: SnapshotWrite) => {
        this.insertSnapshot.run(
          s.sessionId,
          s.baseSeq,
          s.schemaVersion,
          s.geometryCols,
          s.geometryRows,
          s.payload,
          s.createdMs,
        );
      });
      // `.immediate` requests an IMMEDIATE transaction (BEGIN IMMEDIATE)
      // — see better-sqlite3 docs `transaction.immediate(...)`.
      txn.immediate(write);
      this.recordSuccess(state);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('write-failed', write.sessionId, 'pty_snapshot', error);
      if (isDiskClassError(error)) {
        this.recordFailure(state, write.sessionId, error);
      }
      // Do NOT rethrow disk-class errors — the spec says drop, not retry.
      // Non-disk errors (programmer errors) DO propagate so tests fail
      // loudly on bugs.
      if (!isDiskClassError(error)) {
        throw error;
      }
    }
  }

  /** Returns the current health state for a session ('healthy' if unseen). */
  getSessionHealth(sessionId: string): SessionHealth {
    return this.sessions.get(sessionId)?.health ?? 'healthy';
  }

  /**
   * Drain every per-session queue and stop accepting new writes. Used by
   * graceful shutdown (T5.6 will own the broader shutdown sequence).
   * Returns a promise that resolves once all queues are drained.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const drains: Promise<void>[] = [];
    for (const [sessionId, state] of this.sessions) {
      drains.push(this.drainSession(sessionId, state));
    }
    await Promise.all(drains);
    this.sessions.clear();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('WriteCoalescer has been destroyed');
    }
  }

  private getOrCreateSession(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state) return state;
    state = {
      pendingWrites: [],
      pendingBytes: 0,
      flushTimer: null,
      flushing: false,
      drainWaiters: [],
      consecutiveFailures: 0,
      health: 'healthy',
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  /**
   * Arm a `setTimeout(tickMs)` for the session if one isn't already
   * armed and a flush isn't currently in flight. The timer fires
   * `runFlush` which drains every pending write into a single
   * IMMEDIATE transaction (ch07 §5).
   *
   * No-op if a timer is already pending or `flushing` is true — in the
   * latter case `runFlush` will reschedule itself if more writes
   * arrived during the flush.
   */
  private armFlushTimer(sessionId: string, state: SessionState): void {
    if (state.flushTimer !== null || state.flushing) return;
    state.flushTimer = setTimeout(() => {
      this.runFlush(sessionId, state);
    }, this.tickMs);
    // Do NOT call `.unref()` — graceful shutdown sequencing (T5.6) is
    // responsible for keeping the daemon alive until destroy() drains.
  }

  /**
   * Drain `state.pendingWrites` into one IMMEDIATE transaction. Called
   * by the tick timer; safe re-entry is gated by `state.flushing`.
   *
   * Steps (per Task #184 design):
   *  1. Clear `flushTimer`.
   *  2. Capture pending into a local batch and zero the queue.
   *  3. Run the transaction; on success/failure, decrement
   *     `pendingBytes` by the captured total (drop semantics — spec
   *     ch07 §5 does not retry).
   *  4. Resolve any drain waiters.
   *  5. If new writes arrived while the txn ran, re-arm a fresh tick.
   */
  private runFlush(sessionId: string, state: SessionState): void {
    state.flushTimer = null;
    if (state.pendingWrites.length === 0) {
      this.resolveDrainWaiters(state);
      return;
    }
    const batch = state.pendingWrites;
    state.pendingWrites = [];
    state.flushing = true;
    try {
      this.flushBatch(sessionId, state, batch);
    } finally {
      state.flushing = false;
      this.resolveDrainWaiters(state);
      // New writes that landed during the flush need their own tick.
      if (state.pendingWrites.length > 0) {
        this.armFlushTimer(sessionId, state);
      }
    }
  }

  private resolveDrainWaiters(state: SessionState): void {
    if (state.drainWaiters.length === 0) return;
    if (state.pendingWrites.length > 0 || state.flushing) return;
    const waiters = state.drainWaiters;
    state.drainWaiters = [];
    for (const r of waiters) r();
  }

  /**
   * Drive a session to fully drained state. If a tick is pending, fire
   * it synchronously; if a flush is in-flight, wait for it. Iterates
   * until no pending writes remain.
   */
  private drainSession(sessionId: string, state: SessionState): Promise<void> {
    return new Promise<void>((resolve) => {
      const tryDrain = (): void => {
        if (state.pendingWrites.length === 0 && !state.flushing) {
          if (state.flushTimer !== null) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
          }
          resolve();
          return;
        }
        // Either a flush is in flight or a tick is scheduled. Register
        // a waiter; runFlush() will resolve us, then we re-check.
        state.drainWaiters.push(() => tryDrain());
        // If nothing is in flight and the timer hasn't fired yet, run
        // the flush synchronously now to skip the remaining wait.
        if (!state.flushing && state.flushTimer !== null) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
          this.runFlush(sessionId, state);
        }
      };
      tryDrain();
    });
  }

  private flushBatch(
    sessionId: string,
    state: SessionState,
    batch: readonly DeltaWrite[],
  ): void {
    if (batch.length === 0) return;

    let totalBytes = 0;
    for (const d of batch) totalBytes += d.payload.byteLength;

    try {
      const txn = this.db.transaction((items: readonly DeltaWrite[]) => {
        for (const d of items) {
          this.insertDelta.run(d.sessionId, d.seq, d.payload, d.tsMs);
        }
      });
      // BEGIN IMMEDIATE — chapter 07 §5.
      txn.immediate(batch);
      // Only deduct on success: failures still drop the bytes (spec says
      // do not retry) so we deduct unconditionally below.
      this.recordSuccess(state);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('write-failed', sessionId, 'pty_delta', error);
      if (isDiskClassError(error)) {
        this.recordFailure(state, sessionId, error);
      }
      // Non-disk errors (programmer bugs, e.g. PK collision) still drop
      // the batch — the daemon does not retry and the spec is explicit.
      // We surface them via `write-failed` (above) and swallow rather
      // than rethrow: the tick callback has no caller to propagate to.
    } finally {
      // The bytes are out of the queue regardless of outcome — the spec
      // drops the batch on disk-class failure rather than retrying.
      state.pendingBytes -= totalBytes;
      if (state.pendingBytes < 0) state.pendingBytes = 0;
    }
  }

  private recordSuccess(state: SessionState): void {
    if (state.consecutiveFailures > 0) {
      state.consecutiveFailures = 0;
    }
    if (state.health === 'degraded') {
      state.health = 'healthy';
      // Find the sessionId from the map (state has no back-pointer to
      // keep the SessionState shape minimal — single linear scan is
      // fine; the recovery path is rare).
      const sid = this.findSessionId(state);
      if (sid !== null) this.emit('session-recovered', sid);
    }
  }

  private recordFailure(state: SessionState, sessionId: string, err: Error): void {
    state.consecutiveFailures += 1;
    if (
      state.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD &&
      state.health === 'healthy'
    ) {
      state.health = 'degraded';
      this.emit('session-degraded', sessionId, err);
    }
  }

  private findSessionId(target: SessionState): string | null {
    for (const [sid, state] of this.sessions) {
      if (state === target) return sid;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the SQLite error code (e.g. `SQLITE_FULL`) from a thrown
 * better-sqlite3 error. better-sqlite3 attaches `.code` as a string on
 * its `SqliteError` subclass; falls back to `null` if absent.
 */
export function extractSqliteCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Pure decider: does this error count toward the 3-strike DEGRADED
 * counter per ch07 §5? Exported for tests.
 */
export function isDiskClassError(err: unknown): boolean {
  const code = extractSqliteCode(err);
  return code !== null && DISK_CLASS_CODES.has(code);
}

function clampOverride(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(
      `WriteCoalescer ${name} must be in [${min}, ${max}], got ${value}`,
    );
  }
  return value;
}
