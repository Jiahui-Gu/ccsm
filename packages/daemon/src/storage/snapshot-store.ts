// SnapshotStore — read-only SQLite resolver for post-restart pty-host
// replay. Spec ref: design ch06 §7 ("Daemon restart replay") + ch07 §3
// (`pty_snapshot` / `pty_delta` row layout).
//
// Scope: a NARROW reader interface used by `pty-host/host.ts` (sink)
// to feed the pure `replay.ts` decider on child boot. We deliberately
// do NOT couple this module to the WriteCoalescer (`sqlite/coalescer.ts`)
// — the coalescer is the producer side of the same two tables; this is
// the consumer side. Co-locating reader and writer in one mega-module
// would conflate two distinct concerns (write-back batching vs
// point-in-time read) and make the read path harder to mock in unit
// tests for the replay path.
//
// SRP layering — this module is a `producer` per dev.md §2: it sources
// rows from SQLite and hands them up. No deciders, no side effects
// other than the SELECTs themselves.
//
// Layer 1 — alternatives checked:
//   - Have host.ts call better-sqlite3 directly with inline SQL.
//     Rejected: SRP — host.ts owns the IPC + emitter wiring; mixing
//     SQL parsing + row mapping there bloats the module and makes the
//     replay path untestable without a real DB. Pulling the read into
//     a tiny class with prepared statements is the same pattern the
//     coalescer uses for writes (`db.prepare(...)` once at construction).
//   - Use the existing WriteCoalescer's prepared `INSERT` statements
//     in reverse via raw SQL. Rejected: that file is already 600+ lines
//     and conflating read+write paths there would couple the replay
//     path to coalescer lifecycle (the coalescer can be in a tick-flush
//     state when replay needs to read; reads don't need that gate).
//
// Forever-stable invariants this resolver locks:
//   - `getLatestSnapshot` returns the row with the *highest* `base_seq`
//     (per spec ch06 §4: the "most recent" snapshot is the only one
//     replay needs; older rows are pruned by the coalescer on cadence).
//   - `getDeltasSince` returns rows ordered by ASCENDING `seq`. The
//     decider in `replay.ts` validates monotonicity but ordering at the
//     SQL layer is cheaper than re-sorting in JS.

import type { SqliteDatabase } from '../db/sqlite.js';
import type { RestoreDeltaRow, RestoreSnapshotRow } from '../pty-host/replay.js';

/**
 * Minimal read interface consumed by `pty-host/host.ts`. Defined as an
 * interface (not a class) so unit tests can supply a hand-rolled fake
 * without instantiating better-sqlite3 — the host wire-up tests already
 * use the same pattern for the `coalescer` option (duck-typed by
 * `enqueueSnapshot` etc. in `host.ts`).
 */
export interface SnapshotStore {
  /**
   * Resolve the most-recent `pty_snapshot` row for the session, or
   * `null` if none exists. The "most recent" is the row with the
   * highest `base_seq` (ties impossible — `(session_id, base_seq)` is
   * the primary key per `db/migrations/001_initial.sql`).
   */
  getLatestSnapshot(sessionId: string): RestoreSnapshotRow | null;
  /**
   * Resolve every `pty_delta` row with `seq > sinceBaseSeq` for the
   * session, in ascending `seq` order. Returns an empty array if none.
   * `sinceBaseSeq` is exclusive (matches the snapshot semantics: the
   * snapshot at `base_seq=N` already covers everything through seq=N).
   */
  getDeltasSince(sessionId: string, sinceBaseSeq: bigint): RestoreDeltaRow[];
}

/**
 * Production implementation backed by a `better-sqlite3` handle.
 * Owns two prepared statements (one per query) created at construction
 * so the per-call cost is just bind+step — same pattern as
 * `sqlite/coalescer.ts` (which prepares `INSERT INTO pty_snapshot` /
 * `INSERT INTO pty_delta` at construction).
 *
 * Lifecycle: the daemon main process owns the SQLite handle and
 * passes the same instance to both the coalescer (writes) and this
 * store (reads). Single-handle better-sqlite3 with WAL serializes
 * readers/writers safely (spec ch07 §1).
 */
export class SqliteSnapshotStore implements SnapshotStore {
  readonly #selectLatestSnapshot;
  readonly #selectDeltasSince;

  constructor(db: SqliteDatabase) {
    // Index `idx_pty_snapshot_recent (session_id, base_seq DESC)` from
    // `001_initial.sql` makes this a single index seek.
    this.#selectLatestSnapshot = db.prepare(
      'SELECT base_seq, schema_version, geometry_cols, geometry_rows, payload, created_ms ' +
        'FROM pty_snapshot WHERE session_id = ? ORDER BY base_seq DESC LIMIT 1',
    );
    // PK `(session_id, seq)` covers this scan; `seq > ?` uses the index
    // and the explicit ORDER BY guarantees the contract regardless of
    // SQLite's planner.
    this.#selectDeltasSince = db.prepare(
      'SELECT seq, payload, ts_ms FROM pty_delta ' +
        'WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
    );
  }

  getLatestSnapshot(sessionId: string): RestoreSnapshotRow | null {
    // better-sqlite3 returns `unknown` from `.get()` until you teach it
    // a row type; we shape-check the columns we need and coerce the
    // INTEGER columns to `bigint` (the schema stores them as INTEGER
    // but downstream code uses bigint to match the IPC seq encoding).
    // Using `safeIntegers` would force every consumer to deal with
    // BigInt; we keep the conversion local to the read path.
    const row = this.#selectLatestSnapshot.get(sessionId) as
      | undefined
      | {
          base_seq: number | bigint;
          schema_version: number;
          geometry_cols: number;
          geometry_rows: number;
          payload: Buffer | Uint8Array;
          created_ms: number | bigint;
        };
    if (row === undefined) return null;
    return {
      baseSeq: toBigInt(row.base_seq),
      schemaVersion: row.schema_version,
      geometry: { cols: row.geometry_cols, rows: row.geometry_rows },
      // better-sqlite3 returns BLOBs as Node `Buffer` (which extends
      // Uint8Array) — pass through unchanged so `subarray`/`length`
      // work either way at the consumer.
      payload: row.payload,
      createdMs: Number(row.created_ms),
    };
  }

  getDeltasSince(sessionId: string, sinceBaseSeq: bigint): RestoreDeltaRow[] {
    // `seq > ?` accepts a JS number for binding; we narrow `bigint`
    // through Number() because the seq column is INTEGER (max safe
    // 2^53). Spec §2.1 ("monotonic per-session") never reaches that
    // range in v0.3 — the cadence triggers cap snapshot frequency
    // well below 10^15 seqs.
    const rows = this.#selectDeltasSince.all(
      sessionId,
      Number(sinceBaseSeq),
    ) as Array<{
      seq: number | bigint;
      payload: Buffer | Uint8Array;
      ts_ms: number | bigint;
    }>;
    return rows.map((r) => ({
      seq: toBigInt(r.seq),
      tsUnixMs: toBigInt(r.ts_ms),
      payload: r.payload,
    }));
  }
}

function toBigInt(v: number | bigint): bigint {
  return typeof v === 'bigint' ? v : BigInt(v);
}
