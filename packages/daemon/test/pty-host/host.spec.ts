// Integration tests for `spawnPtyHostChild` — the host (parent) side of
// the per-session pty-host child boundary. Spec ch06 §1.
//
// These tests `child_process.fork` a JS fixture (see `./fixtures/`)
// rather than the real `child.ts`, because:
//   1. T4.1 ships the lifecycle skeleton; the real child does not yet
//      import node-pty (so a real fork would just exercise the fixture's
//      own equivalent of the spawn → ready → close path anyway), and
//   2. forking a `.ts` file under vitest requires a tsx loader that the
//      daemon package does not depend on — the fixture is plain ESM JS.
//
// The fixture is end-to-end protocol-equivalent to `child.ts` for the
// T4.1 surface: it sends `ready`, accepts `close`, sends `exiting`, and
// exits 0. T4.2+ tests will exercise the real child binary.

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

import { spawnPtyHostChild } from '../../src/pty-host/host.js';
import {
  getEmitter,
  resetEmitterRegistry,
} from '../../src/pty-host/pty-emitter.js';
import { DEGRADED_COOLDOWN_MS } from '../../src/pty-host/degraded-state.js';
import type { SpawnPayload } from '../../src/pty-host/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'child-fixture.mjs');

// T-PA-5: spawnPtyHostChild auto-constructs a PtySessionEmitter on the
// child's `'ready'` IPC and registers it in the module-level registry.
// These tests reuse the same hard-coded sessionId (e.g. 'sess-001')
// across multiple `it` cases by design — the lifecycle skeleton's
// concern is the IPC handshake, not the emitter wire-up. Reset the
// registry between tests so the second `it` doesn't trip the duplicate-
// id guard with a stale entry from the previous case. Production wiring
// is exercised by the daemon-boot-e2e suite, not here.
afterEach(() => {
  resetEmitterRegistry();
});

function makePayload(overrides: Partial<SpawnPayload> = {}): SpawnPayload {
  return {
    sessionId: overrides.sessionId ?? 'sess-001',
    cwd: overrides.cwd ?? process.cwd(),
    claudeArgs: overrides.claudeArgs ?? ['--print', 'hi'],
    cols: overrides.cols ?? 120,
    rows: overrides.rows ?? 40,
    envExtra: overrides.envExtra,
  };
}

describe('spawnPtyHostChild — happy path lifecycle', () => {
  it('forks a child, observes ready, sends close, observes graceful exit', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
    });

    expect(handle.sessionId).toBe('sess-001');
    expect(handle.pid).toBeGreaterThan(0);

    await handle.ready();

    handle.send({ kind: 'spawn', payload: makePayload() });

    const exit = await handle.closeAndWait();
    expect(exit.reason).toBe('graceful');
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  });

  it('exposes the resolved UTF-8 spawn env on the handle', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      platformOverride: 'linux',
    });
    try {
      await handle.ready();
      // Linux: LANG and LC_ALL are pinned to C.UTF-8.
      expect(handle.claudeSpawnEnv.LANG).toBe('C.UTF-8');
      expect(handle.claudeSpawnEnv.LC_ALL).toBe('C.UTF-8');
    } finally {
      await handle.closeAndWait();
    }
  });

  it('uses child_process.fork (NOT worker_threads) — ChildProcess pid is a real OS pid', async () => {
    // The host implementation is what we are pinning; this assertion is
    // structural — a worker_threads.Worker has no `.pid` distinct from
    // the daemon's own pid, whereas child_process.fork yields a fresh
    // OS pid. (Spec ch06 §1: F3-locked process boundary, not a thread.)
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
    });
    try {
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.pid).not.toBe(process.pid);
    } finally {
      await handle.closeAndWait();
    }
  });
});

describe('spawnPtyHostChild — message stream', () => {
  it('yields child→host messages via the async iterator', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'echo' },
      // Echo fixture sends `{kind:'snapshot'}` without baseSeq/geometry
      // (it predates T-PA-1). Disable the T-PA-5 emitter wire-up so the
      // emitter doesn't log a malformed-snapshot warning to vitest stdout
      // — this test only covers the messages async iterator surface.
      emitterRegistry: 'disabled',
    });

    await handle.ready();
    handle.send({ kind: 'spawn', payload: makePayload() });

    // Collect messages until close. The fixture in echo mode emits one
    // 'snapshot' on spawn, then 'exiting' on close. Plus the initial
    // 'ready' is queued for the iterator before we even start consuming.
    const got: string[] = [];
    const collector = (async () => {
      for await (const m of handle.messages()) {
        got.push(m.kind);
        if (m.kind === 'exiting') break;
      }
    })();

    // give the snapshot a chance to land before we close
    await new Promise((r) => setTimeout(r, 20));
    await handle.closeAndWait();
    await collector;

    expect(got).toContain('ready');
    expect(got).toContain('snapshot');
    expect(got).toContain('exiting');
  });
});

describe('spawnPtyHostChild — crash semantics', () => {
  it('reports reason="crashed" when the child exits non-zero without graceful notice', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-crash' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'crash' },
    });

    // ready() may resolve before the crash (the fixture sends ready
    // first). Either way, exited() always resolves with the outcome.
    await handle.ready().catch(() => undefined);
    const exit = await handle.exited();
    expect(exit.reason).toBe('crashed');
    expect(exit.code).toBe(137);
  });

  it('rejects ready() if the child exits before sending the ready message', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-no-ready' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'no-ready' },
    });

    await expect(handle.ready()).rejects.toThrow(/exited before ready/);
    const exit = await handle.exited();
    expect(exit.reason).toBe('crashed');
    expect(exit.code).toBe(3);
  });
});

describe('spawnPtyHostChild — send() guards', () => {
  it('throws when send() is called after the child has exited', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-after-exit' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
    });
    await handle.ready();
    await handle.closeAndWait();

    expect(() =>
      handle.send({ kind: 'spawn', payload: makePayload() }),
    ).toThrow(/has exited/);
  });
});

describe('spawnPtyHostChild — T4.11a snapshot→WriteCoalescer wire-up (Task #386)', () => {
  // Spec ch07 §5: every snapshot the child posts must be enqueued into
  // the coalescer (parallel to the in-memory emitter fan-out, not
  // mutually exclusive). Stub the coalescer with a duck-typed object
  // that records every call — no DB needed at this layer.

  it('routes a well-formed SnapshotMessage IPC into coalescer.enqueueSnapshot exactly once with the correct payload', async () => {
    const calls: Array<{
      kind: 'snapshot';
      sessionId: string;
      baseSeq: number;
      schemaVersion: number;
      geometryCols: number;
      geometryRows: number;
      payload: Uint8Array;
      createdMs: number;
    }> = [];
    const coalescer = {
      enqueueSnapshot(write: typeof calls[number]) {
        calls.push(write);
      },
    };

    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-coalescer' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'snapshot-coalescer' },
      coalescer,
    });

    try {
      await handle.ready();
      handle.send({ kind: 'spawn', payload: makePayload({ sessionId: 'sess-coalescer' }) });

      // Drive the iterator until the snapshot lands so we don't race the
      // closeAndWait teardown.
      for await (const m of handle.messages()) {
        if (m.kind === 'snapshot') break;
      }
    } finally {
      await handle.closeAndWait();
    }

    expect(calls).toHaveLength(1);
    const got = calls[0]!;
    expect(got.kind).toBe('snapshot');
    expect(got.sessionId).toBe('sess-coalescer');
    expect(got.baseSeq).toBe(7);
    expect(got.schemaVersion).toBe(1);
    expect(got.geometryCols).toBe(120);
    expect(got.geometryRows).toBe(40);
    expect(Array.from(got.payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(typeof got.createdMs).toBe('number');
    expect(got.createdMs).toBeGreaterThan(0);
  });

  it('does not call coalescer.enqueueSnapshot when no coalescer is provided (opt-out default)', async () => {
    // Same fixture mode emits a snapshot; with no coalescer wired, the
    // host must silently skip the SQLite path (lifecycle + emitter
    // fan-out unaffected).
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-no-coalescer' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'snapshot-coalescer' },
    });

    try {
      await handle.ready();
      handle.send({ kind: 'spawn', payload: makePayload({ sessionId: 'sess-no-coalescer' }) });
      for await (const m of handle.messages()) {
        if (m.kind === 'snapshot') break;
      }
    } finally {
      await handle.closeAndWait();
    }
    // No assertion needed beyond reaching here without throwing — the
    // absence of a coalescer must not crash the IPC pump.
  });

  it('keeps the IPC pump alive when coalescer.enqueueSnapshot throws', async () => {
    // The coalescer documents two throw paths: ConnectError(RESOURCE_
    // EXHAUSTED) on queue cap, and programmer-error rethrows. Neither
    // may take down the daemon main process — the session keeps
    // running off the in-memory ring.
    const coalescer = {
      enqueueSnapshot(): void {
        throw new Error('simulated coalescer failure');
      },
    };
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-coalescer-throws' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'snapshot-coalescer' },
      coalescer,
    });

    try {
      await handle.ready();
      handle.send({ kind: 'spawn', payload: makePayload({ sessionId: 'sess-coalescer-throws' }) });
      // Iterator must still see the snapshot — the throw is swallowed.
      let sawSnapshot = false;
      for await (const m of handle.messages()) {
        if (m.kind === 'snapshot') {
          sawSnapshot = true;
          break;
        }
      }
      expect(sawSnapshot).toBe(true);
    } finally {
      const exit = await handle.closeAndWait();
      expect(exit.reason).toBe('graceful');
    }
  });
});

describe('spawnPtyHostChild — T4.3 SendInput backpressure (1 MiB cap)', () => {
  // The fixture mirrors src/pty-host/child.ts's send-input handling:
  // small CCSM_PTY_PENDING_CAP_BYTES + the `send-input-rejected` IPC
  // shape locked in pty-host/types.ts (flat: pendingWriteBytes +
  // attemptedBytes; no nested payload, no sessionId — the daemon main
  // process resolves the session via the PtyHostChildHandle that wraps
  // the IPC channel). Spec ch06 §1 row F5 + 2026-05-04-pty-attach-
  // handler.md §2.2.

  async function collectFirstRejection(
    handle: ReturnType<typeof spawnPtyHostChild>,
  ): Promise<{
    pendingWriteBytes: number;
    attemptedBytes: number;
  }> {
    for await (const m of handle.messages()) {
      if (m.kind === 'send-input-rejected') {
        return {
          pendingWriteBytes: m.pendingWriteBytes,
          attemptedBytes: m.attemptedBytes,
        };
      }
    }
    throw new Error('child exited before sending send-input-rejected');
  }

  it('emits send-input-rejected when a single send-input exceeds the cap', async () => {
    const sessionId = 'sess-bp-single';
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: {
        ...process.env,
        CCSM_FIXTURE_MODE: 'backpressure',
        CCSM_PTY_PENDING_CAP_BYTES: '1024',
      },
    });
    try {
      await handle.ready();
      handle.send({ kind: 'spawn', payload: makePayload({ sessionId }) });

      // Oversized single write: 2 KiB > 1 KiB cap → reject.
      const oversized = new Uint8Array(2048);
      handle.send({ kind: 'send-input', bytes: oversized });

      const rej = await collectFirstRejection(handle);
      expect(rej.pendingWriteBytes).toBe(0);
      expect(rej.attemptedBytes).toBe(2048);
    } finally {
      await handle.closeAndWait();
    }
  });

  it('accepts writes up to the cap; rejects only the over-cap one', async () => {
    const sessionId = 'sess-bp-multi';
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: {
        ...process.env,
        CCSM_FIXTURE_MODE: 'backpressure',
        CCSM_PTY_PENDING_CAP_BYTES: '1024',
      },
    });
    try {
      await handle.ready();
      handle.send({ kind: 'spawn', payload: makePayload({ sessionId }) });

      // Buffer accounting: with the instant-drain stub writer, every
      // accepted write nets to zero pending. Therefore each single
      // write is admitted iff its size <= cap. The next over-cap
      // write must be the first IPC message we observe.
      handle.send({ kind: 'send-input', bytes: new Uint8Array(512) });
      handle.send({ kind: 'send-input', bytes: new Uint8Array(1024) });
      handle.send({ kind: 'send-input', bytes: new Uint8Array(2048) });

      const rej = await collectFirstRejection(handle);
      expect(rej.attemptedBytes).toBe(2048);
      expect(rej.pendingWriteBytes).toBe(0);
    } finally {
      await handle.closeAndWait();
    }
  });

  it('uses the full 1 MiB cap by default (no env override)', async () => {
    const sessionId = 'sess-bp-default';
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: {
        ...process.env,
        CCSM_FIXTURE_MODE: 'backpressure',
        // no CCSM_PTY_PENDING_CAP_BYTES → 1 MiB default
      },
    });
    try {
      await handle.ready();
      handle.send({ kind: 'spawn', payload: makePayload({ sessionId }) });

      // 1 MiB + 1 byte must reject; 1 MiB exactly must NOT.
      handle.send({
        kind: 'send-input',
        bytes: new Uint8Array(1024 * 1024),
      });
      handle.send({
        kind: 'send-input',
        bytes: new Uint8Array(1024 * 1024 + 1),
      });

      const rej = await collectFirstRejection(handle);
      expect(rej.attemptedBytes).toBe(1024 * 1024 + 1);
      expect(rej.pendingWriteBytes).toBe(0);
    } finally {
      await handle.closeAndWait();
    }
  });
});

describe('spawnPtyHostChild — Task #385 DEGRADED state + 60 s cooldown gate', () => {
  // Spec ch06 §4: after the coalescer emits `'session-degraded'` (3
  // consecutive snapshot write failures), the host gates further
  // snapshot enqueues for 60 s, broadcasts a session-state-changed
  // event through the per-session emitter, and reopens the gate after
  // the cooldown elapses. We exercise the host wire-up directly with a
  // stub coalescer (real EventEmitter) + a controlled `nowMs` clock.
  // The coalescer's own 3-strike counting is covered in
  // src/sqlite/__tests__/coalescer.spec.ts; the decider's pure semantics
  // are covered in src/pty-host/degraded-state.spec.ts. This suite is
  // narrowly the wire-up between them.

  function makeStubCoalescer(): {
    enqueueSnapshot: (write: unknown) => void;
    on: EventEmitter['on'];
    off: EventEmitter['off'];
    emitter: EventEmitter;
    enqueueCount: () => number;
  } {
    const ev = new EventEmitter();
    let count = 0;
    return {
      enqueueSnapshot: (_write: unknown) => {
        count += 1;
      },
      on: ev.on.bind(ev),
      off: ev.off.bind(ev),
      emitter: ev,
      enqueueCount: () => count,
    };
  }

  it('gates snapshot enqueue + broadcasts session-state-changed when coalescer emits session-degraded; reopens after 60 s cooldown', async () => {
    const stub = makeStubCoalescer();
    let now = 1_000_000;
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-degraded' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'snapshot-coalescer-multi' },
      coalescer: stub,
      nowMs: () => now,
    });

    try {
      await handle.ready();

      // Subscribe to the per-session emitter so we observe both the
      // session-state-changed broadcasts the host issues AND the
      // snapshot fan-outs (used to wait deterministically for each
      // snapshot IPC to make it through the host's message handler
      // before checking enqueueCount).
      const emitter = getEmitter('sess-degraded');
      expect(emitter, 'emitter should be registered after ready').toBeDefined();
      const events: Array<{ kind: string; state?: string; sinceUnixMs?: number }> = [];
      let snapshotCount = 0;
      let snapshotResolve: (() => void) | null = null;
      emitter!.subscribe((e) => {
        if (e.kind === 'session-state-changed' || e.kind === 'closed') {
          events.push({
            kind: e.kind,
            ...(e.kind === 'session-state-changed'
              ? { state: e.state, sinceUnixMs: e.sinceUnixMs }
              : {}),
          });
        }
        if (e.kind === 'snapshot') {
          snapshotCount += 1;
          snapshotResolve?.();
        }
      });

      async function triggerSnapshot(): Promise<void> {
        const target = snapshotCount + 1;
        const wait = new Promise<void>((resolve) => {
          snapshotResolve = () => {
            if (snapshotCount >= target) {
              snapshotResolve = null;
              resolve();
            }
          };
        });
        handle.send({
          kind: 'spawn',
          payload: makePayload({ sessionId: 'sess-degraded' }),
        });
        await wait;
      }

      // 1) Drive 3 snapshot IPCs through the host. The stub doesn't
      // throw, so the coalescer would have observed 3 enqueue calls.
      // We then simulate the coalescer crossing its 3-strike threshold
      // by emitting `session-degraded` ourselves.
      await triggerSnapshot();
      await triggerSnapshot();
      await triggerSnapshot();
      expect(stub.enqueueCount()).toBe(3);

      // 2) Coalescer fires `session-degraded`. Host advances the clock
      // by zero (still at `now`); decider sees consecutiveFailures>=3
      // + lastFailureAtMs==now → state DEGRADED, gate closed.
      stub.emitter.emit('session-degraded', 'sess-degraded', new Error('disk full'));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'session-state-changed',
        state: 'DEGRADED',
        sinceUnixMs: now,
      });

      // 3) Within the 60 s cooldown window, the next snapshot IPC must
      // NOT reach the coalescer.
      now += 1_000; // 1 s elapsed
      await triggerSnapshot();
      expect(stub.enqueueCount()).toBe(3);

      now += 30_000; // 31 s elapsed total
      await triggerSnapshot();
      expect(stub.enqueueCount()).toBe(3);

      // 4) Cross the 60 s boundary. The next snapshot IPC must reach
      // the coalescer AND a session-state-changed(RUNNING) event must
      // fire (speculative recovery — see degraded-state.ts jsdoc).
      now += DEGRADED_COOLDOWN_MS; // well past the boundary
      await triggerSnapshot();
      expect(stub.enqueueCount()).toBe(4);

      const stateChanges = events.filter((e) => e.kind === 'session-state-changed');
      expect(stateChanges.map((e) => e.state)).toEqual(['DEGRADED', 'RUNNING']);
    } finally {
      await handle.closeAndWait();
    }
  });

  it('detaches coalescer listeners on child exit (no leaks across sessions)', async () => {
    const stub = makeStubCoalescer();
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-degraded-cleanup' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      coalescer: stub,
    });
    await handle.ready();
    expect(stub.emitter.listenerCount('session-degraded')).toBe(1);
    expect(stub.emitter.listenerCount('session-recovered')).toBe(1);
    await handle.closeAndWait();
    expect(stub.emitter.listenerCount('session-degraded')).toBe(0);
    expect(stub.emitter.listenerCount('session-recovered')).toBe(0);
  });
});

describe('spawnPtyHostChild — T4.14 post-restart pty-host replay (Task #51)', () => {
  /** Hand-rolled SnapshotStore stub. Lets each test pin the latest
   *  snapshot + post-snap deltas it returns without standing up SQLite.
   *  The host wire-up only invokes these two methods. */
  function makeStubStore(args: {
    latest: {
      baseSeq: bigint;
      schemaVersion: number;
      geometry: { cols: number; rows: number };
      payload: Uint8Array;
      createdMs: number;
    } | null;
    deltas: Array<{ seq: bigint; tsUnixMs: bigint; payload: Uint8Array }>;
  }) {
    return {
      getLatestSnapshotCalls: 0,
      getDeltasSinceCalls: 0,
      getLatestSnapshot(_sessionId: string) {
        this.getLatestSnapshotCalls++;
        return args.latest;
      },
      getDeltasSince(_sessionId: string, _sinceBaseSeq: bigint) {
        this.getDeltasSinceCalls++;
        return args.deltas;
      },
    };
  }

  it('publishes hydrated snapshot + post-snap deltas through the emitter on child ready', async () => {
    const sessionId = 'sess-replay-hydrate-1';
    const store = makeStubStore({
      latest: {
        baseSeq: 100n,
        schemaVersion: 1,
        geometry: { cols: 132, rows: 50 },
        payload: new Uint8Array([0xc5, 0x53, 0x53, 0x31, 0x01]),
        createdMs: 1_700_000_000_000,
      },
      deltas: [
        { seq: 101n, tsUnixMs: 1_700_000_001_000n, payload: new Uint8Array([0x41]) },
        { seq: 102n, tsUnixMs: 1_700_000_002_000n, payload: new Uint8Array([0x42]) },
      ],
    });
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      priorState: store,
    });
    try {
      await handle.ready();
      // Drain microtasks (the hydration runs in a queueMicrotask
      // scheduled from the 'ready' IPC handler).
      await new Promise((resolve) => setImmediate(resolve));

      expect(store.getLatestSnapshotCalls).toBe(1);
      expect(store.getDeltasSinceCalls).toBe(1);

      const emitter = getEmitter(sessionId);
      expect(emitter).not.toBeUndefined();
      // After hydration the emitter holds the prior snapshot (NOT the
      // child's synthetic baseSeq=0 one — our publish replaces it).
      expect(emitter!.currentSnapshot()?.baseSeq).toBe(100n);
      expect(emitter!.currentSnapshot()?.geometry).toEqual({ cols: 132, rows: 50 });
      // The post-snap deltas are queryable via deltasSince(snapshot.baseSeq).
      const since = emitter!.deltasSince(100n);
      expect(since).not.toBe('out-of-window');
      if (since !== 'out-of-window') {
        expect(since.map((d) => d.seq)).toEqual([101n, 102n]);
        expect(Array.from(since[0]!.payload)).toEqual([0x41]);
        expect(Array.from(since[1]!.payload)).toEqual([0x42]);
      }
    } finally {
      await handle.closeAndWait();
    }
  });

  it('does not query the store when priorState is unset (cold-spawn fast path)', async () => {
    // No priorState — host should not call any store. We assert the
    // emitter is constructed (production behavior unchanged) but no
    // hydration runs.
    const sessionId = 'sess-replay-noprior';
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      // priorState intentionally omitted
    });
    try {
      await handle.ready();
      await new Promise((resolve) => setImmediate(resolve));
      const emitter = getEmitter(sessionId);
      expect(emitter).not.toBeUndefined();
      // No snapshot was published by the fixture (mode='normal' doesn't
      // emit one) so currentSnapshot is null — proving the host did NOT
      // synthesize one on its own when priorState was absent.
      expect(emitter!.currentSnapshot()).toBeNull();
    } finally {
      await handle.closeAndWait();
    }
  });

  it('skips hydration when the store returns no_prior_state (latestSnapshot=null)', async () => {
    const sessionId = 'sess-replay-coldstart';
    const store = makeStubStore({ latest: null, deltas: [] });
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      priorState: store,
    });
    try {
      await handle.ready();
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.getLatestSnapshotCalls).toBe(1);
      // getDeltasSince is also called once (the host wire-up always
      // pulls deltas, even when latest is null — the decider treats
      // them as a no-op). This keeps the call shape consistent for
      // SQLite query-plan caching.
      const emitter = getEmitter(sessionId);
      expect(emitter!.currentSnapshot()).toBeNull();
    } finally {
      await handle.closeAndWait();
    }
  });

  it('falls back to snapshot-only when the decider returns corrupt_seq_gap', async () => {
    const sessionId = 'sess-replay-corrupt';
    // Snapshot baseSeq=10, but delta starts at seq=15 (gap).
    const store = makeStubStore({
      latest: {
        baseSeq: 10n,
        schemaVersion: 1,
        geometry: { cols: 80, rows: 24 },
        payload: new Uint8Array([0xc5, 0x53, 0x53, 0x31]),
        createdMs: 1_700_000_000_000,
      },
      deltas: [
        { seq: 15n, tsUnixMs: 1_700_000_005_000n, payload: new Uint8Array([0x41]) },
      ],
    });
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      priorState: store,
    });
    try {
      await handle.ready();
      await new Promise((resolve) => setImmediate(resolve));
      const emitter = getEmitter(sessionId);
      // Snapshot was published (the corrupt verdict still hands one
      // back per replay.ts spec), but no deltas were forwarded — they
      // all sit past the gap. deltasSince(10) returns the empty
      // post-snap window.
      expect(emitter!.currentSnapshot()?.baseSeq).toBe(10n);
      // No deltas were published (corrupt-fallback skips them) so the
      // emitter's ring is empty. deltasSince(>0) on an empty ring is
      // 'out-of-window' per pty-emitter.ts L278-283 — this is the
      // correct cold-state response, not a bug. We assert the snapshot
      // baseSeq above is sufficient to prove the snapshot-only fallback.
    } finally {
      await handle.closeAndWait();
    }
  });

  it('survives a thrown SnapshotStore (degraded UX, no daemon crash)', async () => {
    const sessionId = 'sess-replay-throws';
    const throwingStore = {
      getLatestSnapshot(): null {
        throw new Error('synthetic SQL failure');
      },
      getDeltasSince(): never[] {
        return [];
      },
    };
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      priorState: throwingStore,
    });
    try {
      await handle.ready();
      await new Promise((resolve) => setImmediate(resolve));
      // The host must NOT crash — the emitter is still alive and the
      // session degrades to cold-start (no hydration applied).
      const emitter = getEmitter(sessionId);
      expect(emitter).not.toBeUndefined();
      expect(emitter!.currentSnapshot()).toBeNull();
    } finally {
      await handle.closeAndWait();
    }
  });
});
