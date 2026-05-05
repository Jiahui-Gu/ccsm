// packages/daemon/test/integration/crash-stream.spec.ts
//
// T8.10 — integration spec: CrashService.WatchCrashLog streams CrashEntry
// events from an in-memory CrashManager.
//
// Spec ch12 §3:
//   "crash-stream.spec.ts — CrashService.WatchCrashLog happy path:
//    trigger every capture source via test hooks; assert each emitted."
//
// Spec ch04 §5 (CrashService) + ch09 §1 (capture sources, open string set):
//   v0.3 source enum is open-string; this spec exercises a representative
//   set covering the categories called out in ch09 §1 (sqlite_op,
//   uncaught_exception, claude_exit, supervisor_shutdown, ...). Adding a
//   new source in v0.4+ does NOT require changing this spec — the assertion
//   is "every event the CrashManager emits reaches the client", not "the
//   client receives a specific finite set of source strings".
//
// Out of scope:
//   - The real CrashManager + capture sources (T5.11 / Task #62) — this
//     spec stands in a tiny in-memory event bus that emits the same
//     `CrashRawEntry` shape T5.11 will produce.
//   - The owner-scoped filter (`OwnerFilter.OWN` vs `ALL`) — covered in
//     a separate `crash-watch-owner-filter.spec.ts` (T8.x); here we
//     assert the OWN default delivers events whose owner matches the
//     caller, plus the `daemon-self` sentinel which OWN includes by
//     definition (ch12 §3 / ch09 §1).
//
// SRP:
//   - Producer: a `CrashEventBus` (in-test, ~30 lines) that emits
//     `CrashRawEntry` rows when its `emit()` is called.
//   - Decider: the `WatchCrashLog` handler (in-test) — converts emitted
//     events into the proto `CrashEntry` shape and pushes them through
//     the async generator.
//   - Sink: the client side `for-await-of` collects events; `afterEach`
//     stops the harness and unblocks the generator.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import type { HandlerContext } from '@connectrpc/connect';

import {
  CrashEntrySchema,
  CrashService,
  ErrorDetailSchema,
  type ErrorDetail,
  OwnerFilter,
  type WatchCrashLogRequest,
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
// In-memory CrashManager stand-in.
//
// Why a tiny bus and not a stub T5.11 module: T5.11 owns persistence +
// capture-source registration. The stream contract under test is purely
// "events flow from emit() to subscribers". Reusing T5.11 here would
// couple this spec to whatever shape that PR lands; a 30-line bus keeps
// the assertion focused on the wire layer.
// ---------------------------------------------------------------------------

interface CrashSubscriber {
  push(entry: CrashRawEntry): void;
  end(): void;
}

class CrashEventBus {
  private readonly subscribers = new Set<CrashSubscriber>();
  private readonly waiters: Array<() => void> = [];

  subscribe(sub: CrashSubscriber): () => void {
    this.subscribers.add(sub);
    // Wake anyone waiting for the subscriber count to be > 0.
    while (this.waiters.length > 0) {
      this.waiters.shift()!();
    }
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /** Resolves the next time `subscribe` is called. Used by tests so they
   *  can `await bus.waitForSubscriber()` BEFORE emitting events the
   *  stream is supposed to deliver — eliminates the 10ms-sleep race. */
  waitForSubscriber(): Promise<void> {
    if (this.subscribers.size > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  emit(entry: CrashRawEntry): void {
    for (const sub of this.subscribers) {
      sub.push(entry);
    }
  }

  closeAll(): void {
    for (const sub of this.subscribers) {
      sub.end();
    }
    this.subscribers.clear();
  }
}

// ---------------------------------------------------------------------------
// Fixture: one event per representative capture source from ch09 §1. The
// `daemon-self` sentinel is explicit — OWN filter MUST surface
// daemon-self events alongside the caller's principal-attributed events
// (ch04 §5 OWNER_FILTER_OWN definition).
// ---------------------------------------------------------------------------

function fixtureEntries(callerPrincipal: string): CrashRawEntry[] {
  // Use deterministic ULIDs so the assertion is order-stable. The first
  // 10 chars are time-derived in a real ULID; here we synthesize them so
  // each test run produces the same lexicographic order.
  return [
    {
      id: '01HZ0TESTSQLITEOPEN0000000A',
      ts_ms: 1_700_000_000_000,
      source: 'sqlite_op',
      summary: 'sqlite OPEN failed: SQLITE_BUSY',
      detail: 'at db.open\n  at boot',
      labels: { op: 'open' },
      owner_id: 'daemon-self',
    },
    {
      id: '01HZ0TESTUNCAUGHTEXC00000B',
      ts_ms: 1_700_000_001_000,
      source: 'uncaught_exception',
      summary: 'TypeError: cannot read x of undefined',
      detail: 'TypeError: cannot read x of undefined\n    at handler',
      labels: {},
      owner_id: 'daemon-self',
    },
    {
      id: '01HZ0TESTCLAUDEEXITED000C',
      ts_ms: 1_700_000_002_000,
      source: 'claude_exit',
      summary: 'claude SDK exited code=137',
      detail: 'SIGKILL',
      labels: { session_id: 'sess-x', pid: '4242' },
      owner_id: callerPrincipal,
    },
    {
      id: '01HZ0TESTSUPERVISORDOWND',
      ts_ms: 1_700_000_003_000,
      source: 'supervisor_shutdown',
      summary: 'graceful shutdown via /shutdown',
      detail: 'reason=installer',
      labels: { reason: 'installer' },
      owner_id: 'daemon-self',
    },
  ];
}

// ---------------------------------------------------------------------------
// Convert raw entry → proto CrashEntry. Mirrors the encoder T5.11 will
// own (ch04 §5 wire shape, ch09 §1 owner_id contract).
// ---------------------------------------------------------------------------

function toProtoEntry(raw: CrashRawEntry) {
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
// Bring up + tear down — fresh bus per test so cross-test leftover events
// cannot leak.
// ---------------------------------------------------------------------------

let harness: Harness;
let bus: CrashEventBus;

beforeEach(async () => {
  bus = new CrashEventBus();
  harness = await startHarness({
    setup(router) {
      router.service(CrashService, {
        async *watchCrashLog(req: WatchCrashLogRequest, ctx: HandlerContext) {
          const principal = ctx.values.get(PRINCIPAL_KEY);
          if (principal === null) {
            throw new Error('principal not set on context');
          }
          // Spec ch15 §3 #14: OwnerFilter MUST reject the broadened
          // value (ALL) on v0.3 with PermissionDenied. Mirrors the
          // production guard in
          // `src/rpc/crash/watch-crash-log.ts:decideOwnerScope` so the
          // wire-shape contract test and the production handler agree
          // on the v0.3 enforcement.
          if (req.ownerFilter === OwnerFilter.ALL) {
            throwError(
              'session.not_owned',
              'OWNER_FILTER_ALL is not permitted on v0.3 (admin scope reserved for v0.4 — spec ch15 §3 #14)',
              { requested_owner_filter: 'ALL' },
            );
          }
          const callerKey = principalKey(principal);
          const ownerFilter = req.ownerFilter;

          // Pump pattern: subscribe to the bus, push entries onto a
          // queue, yield from the queue inside the generator. Keeps
          // back-pressure aligned with the consumer's pull rate.
          const queue: CrashRawEntry[] = [];
          let resolveNext: (() => void) | null = null;
          let ended = false;

          const unsubscribe = bus.subscribe({
            push(entry) {
              // OWN filter: include entries owned by the caller OR the
              // daemon-self sentinel (ch04 §5 OWNER_FILTER_OWN
              // definition). ALL is rejected at the handler entry above
              // (spec ch15 §3 #14) so we only ever reach this branch
              // with UNSPECIFIED/OWN — no ALL pass-through.
              void ownerFilter;
              const ownsIt =
                entry.owner_id === callerKey ||
                entry.owner_id === 'daemon-self';
              if (ownsIt) {
                queue.push(entry);
                if (resolveNext) {
                  resolveNext();
                  resolveNext = null;
                }
              }
            },
            end() {
              ended = true;
              if (resolveNext) {
                resolveNext();
                resolveNext = null;
              }
            },
          });

          // Honor the abort signal so afterEach's harness.stop() unblocks
          // the generator and the test does not hang.
          ctx.signal.addEventListener('abort', () => {
            ended = true;
            unsubscribe();
            if (resolveNext) {
              resolveNext();
              resolveNext = null;
            }
          });

          try {
            while (!ended || queue.length > 0) {
              if (queue.length === 0) {
                await new Promise<void>((resolve) => {
                  resolveNext = resolve;
                });
                continue;
              }
              const entry = queue.shift()!;
              yield toProtoEntry(entry);
            }
          } finally {
            unsubscribe();
          }
        },
      });
    },
  });
});

afterEach(async () => {
  bus.closeAll();
  await harness.stop();
});

// ---------------------------------------------------------------------------
// The spec.
// ---------------------------------------------------------------------------

describe('crash-stream (ch12 §3 / ch04 §5 / ch09 §1)', () => {
  it('every emitted CrashRawEntry surfaces as a CrashEntry on the stream (OWN filter)', async () => {
    const client = harness.makeClient(CrashService);
    const entries = fixtureEntries(TEST_PRINCIPAL_KEY);

    // Start the stream first; emit AFTER the subscriber registers so
    // back-fill semantics are not under test (that is GetCrashLog's job
    // — covered by crash-getlog.spec.ts).
    const stream = client.watchCrashLog({
      meta: newRequestMeta(),
      ownerFilter: OwnerFilter.OWN,
    });

    const collected: Array<{ id: string; source: string; ownerId: string }> = [];
    const collector = (async () => {
      for await (const ev of stream) {
        collected.push({
          id: ev.id,
          source: ev.source,
          ownerId: ev.ownerId,
        });
        if (collected.length === entries.length) {
          break;
        }
      }
    })();

    // Wait for the server-side subscription before emitting — eliminates
    // the race where the stream generator hasn't subscribed yet.
    await bus.waitForSubscriber();
    for (const e of entries) bus.emit(e);

    await collector;

    // Order-preserving assertion: emit order MUST equal receive order
    // for a single stream (ch04 §5 streaming contract).
    expect(collected).toEqual(
      entries.map((e) => ({
        id: e.id,
        source: e.source,
        ownerId: e.owner_id,
      })),
    );

    // Cross-source coverage: the spec's "trigger every capture source via
    // test hooks; assert each emitted" demand. We pin a known set so the
    // PR diff surfaces if a source is renamed silently in v0.4.
    const sources = new Set(collected.map((c) => c.source));
    expect(sources).toEqual(
      new Set(['sqlite_op', 'uncaught_exception', 'claude_exit', 'supervisor_shutdown']),
    );
  });

  it('OWN filter passes daemon-self sentinel entries even when caller is not "daemon-self"', async () => {
    // Spec ch04 §5: OWNER_FILTER_OWN includes `owner_id == 'daemon-self'`
    // alongside `owner_id == principalKey(ctx.principal)`. Daemon-side
    // crashes are surfaced to the local user so the user can see "the
    // daemon crashed" in the renderer.
    const client = harness.makeClient(CrashService);

    const stream = client.watchCrashLog({
      meta: newRequestMeta(),
      ownerFilter: OwnerFilter.OWN,
    });

    const collected: string[] = [];
    const collector = (async () => {
      for await (const ev of stream) {
        collected.push(ev.ownerId);
        if (collected.length === 2) break;
      }
    })();

    await bus.waitForSubscriber();
    bus.emit({
      id: '01HZ0TESTDAEMONSELF000001',
      ts_ms: 1,
      source: 'sqlite_op',
      summary: 's',
      detail: 'd',
      labels: {},
      owner_id: 'daemon-self',
    });
    bus.emit({
      id: '01HZ0TESTDAEMONSELF000002',
      ts_ms: 2,
      source: 'sqlite_op',
      summary: 's',
      detail: 'd',
      labels: {},
      owner_id: TEST_PRINCIPAL_KEY,
    });

    await collector;
    expect(collected).toEqual(['daemon-self', TEST_PRINCIPAL_KEY]);
  });

  it('OWN filter drops events owned by other principals', async () => {
    const client = harness.makeClient(CrashService);

    const stream = client.watchCrashLog({
      meta: newRequestMeta(),
      ownerFilter: OwnerFilter.OWN,
    });

    const collected: string[] = [];
    const collector = (async () => {
      for await (const ev of stream) {
        collected.push(ev.id);
        if (collected.length === 1) break;
      }
    })();

    await bus.waitForSubscriber();
    // First entry is for a different principal — MUST be filtered out.
    bus.emit({
      id: '01HZ0TESTOTHERPRINCIPAL01',
      ts_ms: 1,
      source: 'sqlite_op',
      summary: 's',
      detail: 'd',
      labels: {},
      owner_id: 'local-user:9999',
    });
    // Second entry is for the caller — MUST be the only one received.
    bus.emit({
      id: '01HZ0TESTSELFOWNED000001',
      ts_ms: 2,
      source: 'sqlite_op',
      summary: 's',
      detail: 'd',
      labels: {},
      owner_id: TEST_PRINCIPAL_KEY,
    });

    await collector;
    expect(collected).toEqual(['01HZ0TESTSELFOWNED000001']);
  });

  it('rejects OWNER_FILTER_ALL with PermissionDenied + session.not_owned (Task #433, ch15 §3 #14)', async () => {
    // Spec ch15 §3 #14: OwnerFilter / SettingsScope / WatchScope MUST
    // reject the broadened values (ALL / PRINCIPAL) on v0.3 with
    // PermissionDenied. ALL is reserved for v0.4 admin principals; the
    // wire shape allows it (forever-stable) but the v0.3 daemon's
    // authorization layer refuses it. Mirrors the WATCH_SCOPE_ALL
    // reject test in test/sessions/watch-sessions.spec.ts:403 and the
    // sibling crash-getlog reject test.
    //
    // Reverse-verify: flip the daemon-side guard in
    // `src/rpc/crash/watch-crash-log.ts:decideOwnerScope` (and the
    // mirrored guard in this spec's inline handler) to map ALL back to
    // a permissive verdict -> this test goes RED, proving the
    // assertion is real.
    const client = harness.makeClient(CrashService);
    const stream = client.watchCrashLog({
      meta: newRequestMeta(),
      ownerFilter: OwnerFilter.ALL,
    });
    let captured: unknown = null;
    try {
      for await (const _ev of stream) {
        void _ev;
      }
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
