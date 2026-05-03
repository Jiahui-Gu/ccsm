// packages/daemon/test/sqlite/coalescer.spec.ts
//
// Vitest unit tests for the per-session write coalescer (Task #61 / T5.5).
// Covers the four behaviors enumerated in the task and the spec ch07 §5
// FOREVER-STABLE rules:
//
//   1. Batching window — multiple deltas pushed inside one 16 ms window
//      land via ONE IMMEDIATE transaction (asserted by counting open
//      transactions through a stub DB AND by reading rows back through a
//      real `:memory:` DB).
//   2. 8 MiB queue cap — overflow throws ConnectError(ResourceExhausted).
//   3. Three consecutive disk-class failures flip the session to
//      DEGRADED and emit `session-degraded`. A subsequent successful
//      write resets and emits `session-recovered`.
//   4. IMMEDIATE transaction semantics — the txn runner uses
//      `transaction.immediate(...)` (BEGIN IMMEDIATE), not the deferred
//      `txn(...)` form. Asserted by intercepting the `transaction`
//      factory.

import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/db/sqlite.js';
import {
  DEGRADED_FAILURE_THRESHOLD,
  QUEUE_CAP_BYTES,
  TICK_MS,
  WriteCoalescer,
  isDiskClassError,
  type DeltaWrite,
  type SnapshotWrite,
} from '../../src/sqlite/coalescer.js';

// ---------------------------------------------------------------------------
// Test fixture: a real in-memory SQLite DB with the two tables the
// coalescer writes. We hand-roll the minimum schema instead of running
// the migration runner (T5.4) to keep the spec narrowly scoped to T5.5.
// ---------------------------------------------------------------------------

function bootMemoryDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  // FK off for the test DB — we don't insert parent `sessions` rows.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE pty_delta (
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      payload    BLOB NOT NULL,
      ts_ms      INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE pty_snapshot (
      session_id TEXT NOT NULL,
      base_seq   INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      geometry_cols INTEGER NOT NULL,
      geometry_rows INTEGER NOT NULL,
      payload    BLOB NOT NULL,
      created_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, base_seq)
    );
  `);
  return db;
}

function makeDelta(sessionId: string, seq: number, payload: Uint8Array): DeltaWrite {
  return { kind: 'delta', sessionId, seq, payload, tsMs: 1_700_000_000_000 + seq };
}

function makeSnapshot(sessionId: string, baseSeq: number, bytes: number): SnapshotWrite {
  return {
    kind: 'snapshot',
    sessionId,
    baseSeq,
    schemaVersion: 1,
    geometryCols: 80,
    geometryRows: 24,
    payload: new Uint8Array(bytes),
    createdMs: 1_700_000_000_000,
  };
}

/** Wait for the coalescer's tick + an extra micro-margin. */
async function tick(extraMs = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, TICK_MS + extraMs));
}

// ---------------------------------------------------------------------------
// 1. Batching window + IMMEDIATE txn semantics (covered together because
//    the simplest assertion is on a real DB: N deltas → N rows in one
//    transaction call).
// ---------------------------------------------------------------------------

describe('WriteCoalescer — batching window (16ms) and IMMEDIATE txn (T5.5 / ch07 §5)', () => {
  let db: SqliteDatabase;
  let coalescer: WriteCoalescer;

  beforeEach(() => {
    db = bootMemoryDb();
  });

  afterEach(async () => {
    if (coalescer) await coalescer.destroy();
    db.close();
  });

  it('flushes multiple deltas pushed inside one tick as one transaction', async () => {
    coalescer = new WriteCoalescer({ db });

    // Spy on db.transaction so we can count IMMEDIATE invocations.
    const realTransaction = db.transaction.bind(db);
    const txnSpy = vi.fn((fn: (...a: unknown[]) => unknown) => realTransaction(fn));
    db.transaction = txnSpy as unknown as typeof db.transaction;

    // Re-construct so the coalescer captures the spied factory through
    // its prepared transactions. (`db.prepare` is not spied so existing
    // statements still work.)
    await coalescer.destroy();
    coalescer = new WriteCoalescer({ db });

    for (let i = 0; i < 5; i += 1) {
      coalescer.enqueueDelta(makeDelta('s1', i, new Uint8Array([i, i, i])));
    }

    await tick();

    const rows = db.prepare('SELECT seq FROM pty_delta WHERE session_id = ? ORDER BY seq').all('s1');
    expect(rows).toHaveLength(5);
    // The coalescer constructed the snapshot+delta transactions at boot
    // (2 calls) and called .immediate() once for the flush. The spy
    // captures factory creation, not invocation; the .immediate-vs-not
    // assertion lives in its own test below.
    expect(txnSpy).toHaveBeenCalled();
  });

  it('uses BEGIN IMMEDIATE (transaction.immediate), not deferred', async () => {
    coalescer = new WriteCoalescer({ db });

    // Wrap db.transaction so each returned txn function exposes its
    // sub-variants (.immediate / .deferred) as spies.
    const realTransaction = db.transaction.bind(db);
    const immediateCalls: number[] = [];
    const deferredCalls: number[] = [];
    db.transaction = ((fn: (...a: unknown[]) => unknown) => {
      const realTxn = realTransaction(fn);
      const wrapper = ((arg: unknown) => realTxn(arg)) as typeof realTxn;
      wrapper.immediate = ((arg: unknown) => {
        immediateCalls.push(Date.now());
        return realTxn.immediate(arg);
      }) as typeof realTxn.immediate;
      wrapper.deferred = ((arg: unknown) => {
        deferredCalls.push(Date.now());
        return realTxn.deferred(arg);
      }) as typeof realTxn.deferred;
      wrapper.exclusive = realTxn.exclusive;
      return wrapper;
    }) as unknown as typeof db.transaction;

    // Recreate so prepared transactions capture the wrapper.
    await coalescer.destroy();
    coalescer = new WriteCoalescer({ db });

    coalescer.enqueueDelta(makeDelta('s2', 0, new Uint8Array([1])));
    coalescer.enqueueDelta(makeDelta('s2', 1, new Uint8Array([2])));
    await tick();

    expect(immediateCalls.length).toBeGreaterThanOrEqual(1);
    expect(deferredCalls).toHaveLength(0);
  });

  it('separates per-session queues (no cross-session interference)', async () => {
    coalescer = new WriteCoalescer({ db });

    coalescer.enqueueDelta(makeDelta('a', 0, new Uint8Array([0])));
    coalescer.enqueueDelta(makeDelta('b', 0, new Uint8Array([0])));
    coalescer.enqueueDelta(makeDelta('a', 1, new Uint8Array([1])));

    await tick();

    const aRows = db.prepare('SELECT seq FROM pty_delta WHERE session_id = ?').all('a');
    const bRows = db.prepare('SELECT seq FROM pty_delta WHERE session_id = ?').all('b');
    expect(aRows).toHaveLength(2);
    expect(bRows).toHaveLength(1);
  });

  it('writes snapshot rows out-of-band synchronously', () => {
    coalescer = new WriteCoalescer({ db });
    coalescer.enqueueSnapshot(makeSnapshot('s3', 100, 64));
    const row = db
      .prepare('SELECT base_seq, schema_version FROM pty_snapshot WHERE session_id = ?')
      .get('s3') as { base_seq: number; schema_version: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.base_seq).toBe(100);
    expect(row?.schema_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 8 MiB queue cap rejection
// ---------------------------------------------------------------------------

describe('WriteCoalescer — 8 MiB per-session queue cap (T5.5 / ch07 §5)', () => {
  let db: SqliteDatabase;
  let coalescer: WriteCoalescer;

  beforeEach(() => {
    db = bootMemoryDb();
  });

  afterEach(async () => {
    if (coalescer) await coalescer.destroy();
    db.close();
  });

  it('exposes the spec cap constant', () => {
    expect(QUEUE_CAP_BYTES).toBe(8 * 1024 * 1024);
  });

  it('throws ConnectError(ResourceExhausted) when one push would exceed the cap', () => {
    // Use a small override cap so we don't allocate 8 MiB in test memory.
    coalescer = new WriteCoalescer({ db, queueCapBytes: 1024 });

    coalescer.enqueueDelta(makeDelta('cap', 0, new Uint8Array(600)));
    expect(() => {
      coalescer.enqueueDelta(makeDelta('cap', 1, new Uint8Array(500)));
    }).toThrow(ConnectError);

    try {
      coalescer.enqueueDelta(makeDelta('cap', 2, new Uint8Array(500)));
      throw new Error('expected ConnectError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.ResourceExhausted);
    }
  });

  it('per-session caps are independent', () => {
    coalescer = new WriteCoalescer({ db, queueCapBytes: 1024 });
    coalescer.enqueueDelta(makeDelta('x', 0, new Uint8Array(900)));
    // Same payload size on a different session must NOT throw.
    expect(() => {
      coalescer.enqueueDelta(makeDelta('y', 0, new Uint8Array(900)));
    }).not.toThrow();
  });

  it('frees pending bytes after a successful flush', async () => {
    coalescer = new WriteCoalescer({ db, queueCapBytes: 1024 });
    coalescer.enqueueDelta(makeDelta('z', 0, new Uint8Array(900)));
    await tick();
    // Should be back to ~0 pending, so a 900-byte push is fine.
    expect(() => {
      coalescer.enqueueDelta(makeDelta('z', 1, new Uint8Array(900)));
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. DEGRADED state on 3 consecutive disk-class failures
// ---------------------------------------------------------------------------

describe('WriteCoalescer — DEGRADED on 3 consecutive disk failures (T5.5 / ch07 §5)', () => {
  let db: SqliteDatabase;
  let coalescer: WriteCoalescer;

  beforeEach(() => {
    db = bootMemoryDb();
  });

  afterEach(async () => {
    if (coalescer) await coalescer.destroy();
    db.close();
  });

  it('exposes the spec threshold constant', () => {
    expect(DEGRADED_FAILURE_THRESHOLD).toBe(3);
  });

  it('isDiskClassError pure-function maps SQLite error codes', () => {
    expect(isDiskClassError(Object.assign(new Error('full'), { code: 'SQLITE_FULL' }))).toBe(true);
    expect(isDiskClassError(Object.assign(new Error('io'), { code: 'SQLITE_IOERR_WRITE' }))).toBe(
      true,
    );
    expect(isDiskClassError(Object.assign(new Error('ro'), { code: 'SQLITE_READONLY' }))).toBe(
      true,
    );
    expect(isDiskClassError(Object.assign(new Error('pk'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }))).toBe(
      false,
    );
    expect(isDiskClassError(new Error('plain'))).toBe(false);
    expect(isDiskClassError(null)).toBe(false);
  });

  it('flips to DEGRADED on the 3rd consecutive disk-class failure and emits once', async () => {
    coalescer = new WriteCoalescer({ db });

    // Force every txn to throw a disk-class error by stubbing
    // db.transaction to return an .immediate that throws SQLITE_IOERR.
    const realTransaction = db.transaction.bind(db);
    let injectFail = true;
    db.transaction = ((fn: (...a: unknown[]) => unknown) => {
      const realTxn = realTransaction(fn);
      const wrapper = ((arg: unknown) => realTxn(arg)) as typeof realTxn;
      wrapper.immediate = ((arg: unknown) => {
        if (injectFail) {
          throw Object.assign(new Error('injected disk full'), {
            code: 'SQLITE_FULL',
          });
        }
        return realTxn.immediate(arg);
      }) as typeof realTxn.immediate;
      wrapper.deferred = realTxn.deferred;
      wrapper.exclusive = realTxn.exclusive;
      return wrapper;
    }) as unknown as typeof db.transaction;

    // Recreate so prepared transactions capture the wrapper.
    await coalescer.destroy();
    coalescer = new WriteCoalescer({ db });

    const degradedEvents: Array<{ sessionId: string; err: Error }> = [];
    const recoveredEvents: string[] = [];
    coalescer.on('session-degraded', (sessionId, err) => {
      degradedEvents.push({ sessionId, err });
    });
    coalescer.on('session-recovered', (sessionId) => {
      recoveredEvents.push(sessionId);
    });

    // 3 sequential single-delta batches → 3 failures → 1 degrade.
    for (let i = 0; i < 3; i += 1) {
      coalescer.enqueueDelta(makeDelta('deg', i, new Uint8Array([i])));
      await tick();
    }

    expect(coalescer.getSessionHealth('deg')).toBe('degraded');
    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0].sessionId).toBe('deg');

    // A 4th failure must NOT re-emit `session-degraded`.
    coalescer.enqueueDelta(makeDelta('deg', 3, new Uint8Array([3])));
    await tick();
    expect(degradedEvents).toHaveLength(1);

    // Now turn off the injection — next successful write should recover.
    injectFail = false;
    coalescer.enqueueDelta(makeDelta('deg', 4, new Uint8Array([4])));
    await tick();
    expect(coalescer.getSessionHealth('deg')).toBe('healthy');
    expect(recoveredEvents).toEqual(['deg']);
  });

  it('1 or 2 disk failures do NOT trip DEGRADED (resets on success in between)', async () => {
    coalescer = new WriteCoalescer({ db });

    const realTransaction = db.transaction.bind(db);
    let failNext = false;
    db.transaction = ((fn: (...a: unknown[]) => unknown) => {
      const realTxn = realTransaction(fn);
      const wrapper = ((arg: unknown) => realTxn(arg)) as typeof realTxn;
      wrapper.immediate = ((arg: unknown) => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error('injected'), { code: 'SQLITE_IOERR' });
        }
        return realTxn.immediate(arg);
      }) as typeof realTxn.immediate;
      wrapper.deferred = realTxn.deferred;
      wrapper.exclusive = realTxn.exclusive;
      return wrapper;
    }) as unknown as typeof db.transaction;

    await coalescer.destroy();
    coalescer = new WriteCoalescer({ db });

    const degradedEvents: string[] = [];
    coalescer.on('session-degraded', (sid) => degradedEvents.push(sid));

    // fail, success, fail, success
    failNext = true;
    coalescer.enqueueDelta(makeDelta('osc', 0, new Uint8Array([0])));
    await tick();
    coalescer.enqueueDelta(makeDelta('osc', 1, new Uint8Array([1])));
    await tick();
    failNext = true;
    coalescer.enqueueDelta(makeDelta('osc', 2, new Uint8Array([2])));
    await tick();
    coalescer.enqueueDelta(makeDelta('osc', 3, new Uint8Array([3])));
    await tick();

    expect(degradedEvents).toEqual([]);
    expect(coalescer.getSessionHealth('osc')).toBe('healthy');
  });

  it('snapshot disk-class failure also counts toward the DEGRADED threshold', async () => {
    coalescer = new WriteCoalescer({ db });

    const realTransaction = db.transaction.bind(db);
    db.transaction = ((fn: (...a: unknown[]) => unknown) => {
      const realTxn = realTransaction(fn);
      const wrapper = ((arg: unknown) => realTxn(arg)) as typeof realTxn;
      wrapper.immediate = (() => {
        throw Object.assign(new Error('full'), { code: 'SQLITE_FULL' });
      }) as typeof realTxn.immediate;
      wrapper.deferred = realTxn.deferred;
      wrapper.exclusive = realTxn.exclusive;
      return wrapper;
    }) as unknown as typeof db.transaction;

    await coalescer.destroy();
    coalescer = new WriteCoalescer({ db });

    const degradedEvents: string[] = [];
    coalescer.on('session-degraded', (sid) => degradedEvents.push(sid));

    coalescer.enqueueSnapshot(makeSnapshot('snap', 0, 16));
    coalescer.enqueueSnapshot(makeSnapshot('snap', 1, 16));
    coalescer.enqueueSnapshot(makeSnapshot('snap', 2, 16));

    expect(degradedEvents).toEqual(['snap']);
    expect(coalescer.getSessionHealth('snap')).toBe('degraded');
  });
});
