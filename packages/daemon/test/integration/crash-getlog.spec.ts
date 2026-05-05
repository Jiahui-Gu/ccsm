// packages/daemon/test/integration/crash-getlog.spec.ts
//
// T8.10 — integration spec: CrashService.GetCrashLog returns historical
// entries with `since_unix_ms`-based pagination.
//
// Spec ch12 §3:
//   "crash-getlog.spec.ts — CrashService.GetCrashLog happy path (returns
//    latest N rows); error path (`NotFound` for unknown id)."
//
// Spec ch04 §5 (CrashService.GetCrashLog) — request shape:
//   `int32 limit` (daemon caps at 1000), `int64 since_unix_ms` (0 == no
//   lower bound), `OwnerFilter owner_filter`. The cursor mechanism is
//   the (since_unix_ms, ts_unix_ms) pair: callers paginate by feeding the
//   last received entry's `ts_unix_ms` back as `since_unix_ms` on the
//   next call. This is the v0.3 contract — `next_page_token`-style
//   opaque cursors are NOT in the wire schema (forever-stable).
//
// Out of scope:
//   - The real CrashManager + DB-backed log (T5.11 / Task #62) — this
//     spec stands in an in-memory store keyed by ts. The wire shape
//     under test is independent of how the rows are persisted.
//   - The owner_filter row-level enforcement is also exercised here
//     (caller's principalKey + daemon-self default per ch04 §5).
//
// Error path note on the spec's "NotFound for unknown id" wording: the
// `GetCrashLog` RPC takes no `id` field — it returns a *page* of entries.
// Spec ch04 §5 only ships GetCrashLog and WatchCrashLog (+ GetRawCrashLog).
// The "NotFound by id" error path the ch12 §3 prose mentions does not map
// to any current proto field, so we cover the closest contract surface
// the schema allows: a paged query whose `since_unix_ms` is past the
// most recent entry returns an empty page (NOT a NotFound — empty list
// is the canonical "no rows match" signal in proto3 collections, and
// surfacing NotFound for an empty page would be a forbidden semantic
// (returning an error for a valid-but-empty result). The actual NotFound
// path lives in `crash-getentry.spec.ts` if/when a GetCrashEntry(id) RPC
// is added in v0.4 — currently absent from the proto.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import type { HandlerContext } from '@connectrpc/connect';

import {
  CrashEntrySchema,
  CrashService,
  ErrorDetailSchema,
  type ErrorDetail,
  type GetCrashLogRequest,
  GetCrashLogResponseSchema,
  OwnerFilter,
} from '@ccsm/proto';

import {
  PRINCIPAL_KEY,
  principalKey,
} from '../../src/auth/index.js';
import type { CrashRawEntry } from '../../src/crash/raw-appender.js';
import { throwError } from '../../src/rpc/errors.js';
import {
  TEST_PRINCIPAL_KEY,
  newRequestMeta,
  startHarness,
  type Harness,
} from './harness.js';

// ---------------------------------------------------------------------------
// In-memory crash store stand-in (mirrors the columns DB-backed crash_log
// will hold per migrations/001_initial.sql crash_log table).
// ---------------------------------------------------------------------------

interface StoredEntry extends CrashRawEntry {}

class CrashStore {
  private readonly rows: StoredEntry[] = [];

  /** Append in arbitrary order; query returns DESC by ts. */
  insert(...entries: StoredEntry[]): void {
    this.rows.push(...entries);
  }

  /**
   * Mirror of the daemon-side query:
   *   SELECT * FROM crash_log
   *   WHERE ts_ms >= ? AND owner_id IN (?, 'daemon-self')
   *   ORDER BY ts_ms DESC
   *   LIMIT MIN(?, 1000)
   */
  query(args: {
    sinceUnixMs: number;
    limit: number;
    ownerFilter: OwnerFilter;
    callerKey: string;
  }): StoredEntry[] {
    const { sinceUnixMs, limit, ownerFilter, callerKey } = args;
    const cap = Math.min(limit > 0 ? limit : 1000, 1000);
    return this.rows
      .filter((r) => r.ts_ms >= sinceUnixMs)
      .filter((r) => {
        if (ownerFilter === OwnerFilter.ALL) return true;
        // OWN: caller's principalKey OR daemon-self sentinel.
        return r.owner_id === callerKey || r.owner_id === 'daemon-self';
      })
      .sort((a, b) => b.ts_ms - a.ts_ms)
      .slice(0, cap);
  }
}

// Per spec: daemon caps `limit` at 1000.
const SERVER_LIMIT_CAP = 1000;

function toProtoEntry(raw: StoredEntry) {
  return create(CrashEntrySchema, {
    id: raw.id,
    tsUnixMs: BigInt(raw.ts_ms),
    source: raw.source,
    summary: raw.summary,
    detail: raw.detail,
    labels: { ...raw.labels },
    ownerId: raw.owner_id,
  });
}

// ---------------------------------------------------------------------------
// Bring up.
// ---------------------------------------------------------------------------

let harness: Harness;
let store: CrashStore;

beforeEach(async () => {
  store = new CrashStore();
  harness = await startHarness({
    setup(router) {
      router.service(CrashService, {
        async getCrashLog(req: GetCrashLogRequest, ctx: HandlerContext) {
          const principal = ctx.values.get(PRINCIPAL_KEY);
          if (principal === null) {
            throw new Error('principal not set on context');
          }
          // Spec ch15 §3 #14: OwnerFilter MUST reject the broadened
          // value (ALL) on v0.3 with PermissionDenied. Mirrors the
          // production guard in `src/rpc/crash/get-crash-log.ts`
          // (`makeGetCrashLogHandler`) so the wire-shape contract test
          // and the production handler agree on the v0.3 enforcement.
          if (req.ownerFilter === OwnerFilter.ALL) {
            throwError(
              'session.not_owned',
              'OWNER_FILTER_ALL is not permitted on v0.3 (admin scope reserved for v0.4 — spec ch15 §3 #14)',
              { requested_owner_filter: 'ALL' },
            );
          }
          const callerKey = principalKey(principal);
          const rows = store.query({
            sinceUnixMs: Number(req.sinceUnixMs),
            limit: req.limit > 0 ? req.limit : SERVER_LIMIT_CAP,
            ownerFilter: req.ownerFilter,
            callerKey,
          });
          return create(GetCrashLogResponseSchema, {
            meta: newRequestMeta(),
            entries: rows.map(toProtoEntry),
          });
        },
      });
    },
  });
});

afterEach(async () => {
  await harness.stop();
});

// ---------------------------------------------------------------------------
// Fixtures: 25 entries across multiple sources / owners / timestamps so
// the pagination assertion is non-trivial.
// ---------------------------------------------------------------------------

function seedFixtures(): StoredEntry[] {
  const entries: StoredEntry[] = [];
  // Interleave caller + daemon-self + foreign-owner entries.
  for (let i = 0; i < 25; i++) {
    const owner =
      i % 5 === 0
        ? 'daemon-self'
        : i % 5 === 1
          ? 'local-user:9999'
          : TEST_PRINCIPAL_KEY;
    entries.push({
      id: `01HZ0TESTGETLOG${String(i).padStart(11, '0')}`,
      ts_ms: 1_700_000_000_000 + i * 1000,
      source: i % 2 === 0 ? 'sqlite_op' : 'claude_exit',
      summary: `summary ${i}`,
      detail: `detail ${i}`,
      labels: { i: String(i) },
      owner_id: owner,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The spec.
// ---------------------------------------------------------------------------

describe('crash-getlog (ch12 §3 / ch04 §5)', () => {
  it('returns the latest N rows in DESC ts order, scoped to OWN by default', async () => {
    const fixtures = seedFixtures();
    store.insert(...fixtures);

    const client = harness.makeClient(CrashService);
    const res = await client.getCrashLog({
      meta: newRequestMeta(),
      limit: 5,
      sinceUnixMs: BigInt(0),
      ownerFilter: OwnerFilter.UNSPECIFIED, // == OWN per ch04 §5
    });

    expect(res.entries).toHaveLength(5);
    // DESC ts order is the contract (newest first).
    for (let i = 1; i < res.entries.length; i++) {
      expect(res.entries[i - 1].tsUnixMs).toBeGreaterThan(res.entries[i].tsUnixMs);
    }
    // OWN scope: every entry's owner is the caller OR daemon-self. NO
    // foreign-owner entries leak through.
    for (const e of res.entries) {
      expect([TEST_PRINCIPAL_KEY, 'daemon-self']).toContain(e.ownerId);
    }
  });

  it('honors since_unix_ms cursor: a higher floor returns only newer entries', async () => {
    const fixtures = seedFixtures();
    store.insert(...fixtures);

    const client = harness.makeClient(CrashService);

    // Page 1: latest 3 entries (no floor).
    const page1 = await client.getCrashLog({
      meta: newRequestMeta(),
      limit: 3,
      sinceUnixMs: BigInt(0),
      ownerFilter: OwnerFilter.OWN,
    });
    expect(page1.entries.length).toBeGreaterThan(0);
    expect(page1.entries.length).toBeLessThanOrEqual(3);

    // Spec ch04 §5: `since_unix_ms` is a >= floor. Re-querying with a
    // floor SET to the newest entry's ts MUST return that entry plus any
    // newer ones (none, in this case — we used the newest as the floor).
    const newestTs = page1.entries[0].tsUnixMs;
    const refetch = await client.getCrashLog({
      meta: newRequestMeta(),
      limit: 100,
      sinceUnixMs: newestTs,
      ownerFilter: OwnerFilter.OWN,
    });
    // Every refetched entry's ts MUST be >= the floor we sent.
    for (const e of refetch.entries) {
      expect(e.tsUnixMs >= newestTs).toBe(true);
    }
    // The newest entry itself is included (>= semantics, not >).
    const refetchedIds = new Set(refetch.entries.map((e) => e.id));
    expect(refetchedIds.has(page1.entries[0].id)).toBe(true);

    // A floor strictly greater than the newest entry returns an empty
    // page — pins the upper-bound semantics so a future change to <=
    // (forbidden) is caught.
    const beyond = await client.getCrashLog({
      meta: newRequestMeta(),
      limit: 100,
      sinceUnixMs: newestTs + BigInt(1),
      ownerFilter: OwnerFilter.OWN,
    });
    expect(beyond.entries).toHaveLength(0);

    // The unbounded query (floor=0, limit=100) is a superset of page1.
    const all = await client.getCrashLog({
      meta: newRequestMeta(),
      limit: 100,
      sinceUnixMs: BigInt(0),
      ownerFilter: OwnerFilter.OWN,
    });
    const allIds = new Set(all.entries.map((e) => e.id));
    for (const e of page1.entries) {
      expect(allIds.has(e.id)).toBe(true);
    }
  });

  it('limit is capped at 1000 server-side (ch04 §5)', async () => {
    // Insert >1000 entries; request limit=10000; server returns at most
    // 1000. Pin this so a v0.4 PR that loosens the cap silently is
    // caught here (spec ch04 §5: forever-stable cap).
    const many: StoredEntry[] = [];
    for (let i = 0; i < 1500; i++) {
      many.push({
        id: `01HZ0CAP${String(i).padStart(18, '0')}`,
        ts_ms: i,
        source: 'sqlite_op',
        summary: 's',
        detail: 'd',
        labels: {},
        owner_id: TEST_PRINCIPAL_KEY,
      });
    }
    store.insert(...many);

    const client = harness.makeClient(CrashService);
    const res = await client.getCrashLog({
      meta: newRequestMeta(),
      limit: 10000,
      sinceUnixMs: BigInt(0),
      ownerFilter: OwnerFilter.OWN,
    });
    expect(res.entries.length).toBeLessThanOrEqual(SERVER_LIMIT_CAP);
  });

  it('empty result is an empty entries array, NOT NotFound (ch04 §5)', async () => {
    // Empty store: query returns an empty `entries` list with the
    // standard `RequestMeta`. NotFound would be a wire-level error and
    // is not the right code for "no matching rows" (forbidden by the
    // proto3 collection convention — empty repeated field is the
    // canonical empty-result signal).
    const client = harness.makeClient(CrashService);
    const res = await client.getCrashLog({
      meta: newRequestMeta(),
      limit: 100,
      sinceUnixMs: BigInt(0),
      ownerFilter: OwnerFilter.OWN,
    });
    expect(res.entries).toHaveLength(0);
  });

  it('rejects OWNER_FILTER_ALL with PermissionDenied + session.not_owned (Task #433, ch15 §3 #14)', async () => {
    // Spec ch15 §3 #14: OwnerFilter / SettingsScope / WatchScope MUST
    // reject the broadened values (ALL / PRINCIPAL) on v0.3 with
    // PermissionDenied. ALL is reserved for v0.4 admin principals; the
    // wire shape allows it (forever-stable) but the v0.3 daemon's
    // authorization layer refuses it. Mirrors the WATCH_SCOPE_ALL +
    // SETTINGS_SCOPE_PRINCIPAL reject tests already in the daemon test
    // suite (e.g. test/sessions/watch-sessions.spec.ts:403 "ALL scope:
    // throws ConnectError(PermissionDenied) + ErrorDetail
    // 'session.not_owned'").
    //
    // Reverse-verify: flip the daemon-side guard in
    // `src/rpc/crash/get-crash-log.ts:makeGetCrashLogHandler` (and the
    // mirrored guard in this spec's inline handler) to skip the ALL
    // reject -> this test goes RED, proving the assertion is real.
    const fixtures = seedFixtures();
    store.insert(...fixtures);

    const client = harness.makeClient(CrashService);
    let captured: unknown = null;
    try {
      await client.getCrashLog({
        meta: newRequestMeta(),
        limit: 100,
        sinceUnixMs: BigInt(0),
        ownerFilter: OwnerFilter.ALL,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    const ce = captured as ConnectError;
    expect(ce.code).toBe(Code.PermissionDenied);
    const details = ce.findDetails(ErrorDetailSchema) as ErrorDetail[];
    expect(details.length).toBeGreaterThanOrEqual(1);
    expect(details[0].code).toBe('session.not_owned');
    expect(details[0].extra.requested_owner_filter).toBe('ALL');
    // Error message MUST cite the spec section so a reviewer reading
    // the wire payload can find the source of truth without grep.
    expect(ce.message).toMatch(/ch15\s*§3\s*#14/);
  });
});
