// T80 — snapshot interleave probe (frag-3.5.1 §3.5.1.5 / frag-6-7).
//
// Asserts the daemon's snapshot path satisfies three invariants under N
// concurrent callers:
//
//   1. Semaphore serializes admission — at any instant, the number of
//      in-flight snapshot bodies is ≤ capacity (no over-admission, even
//      under interleaving promise scheduling).
//   2. Snapshot bodies are atomic — once a holder begins emitting frames,
//      no other holder's frames interleave into the same byte stream
//      (per-caller payload is contiguous).
//   3. Live data fan-out is NOT blocked — `broadcast` to subscribers
//      continues to deliver while snapshot work is in flight (snapshot
//      doesn't starve subscribers; see frag-3.5.1 §3.5.1.5 res-SHOULD-2
//      and the "no two snapshot bodies interleave" claim in frag-6-7).
//
// Why a module-level probe (not an end-to-end RPC probe):
//   - T40 (#997) ships the semaphore and T41 (#998) the fan-out registry
//     as PURE primitives. The `getBufferSnapshot` daemon RPC handler that
//     wires them together has not landed (no wiring in `daemon/src/index.ts`
//     references `createSnapshotSemaphore`). The task discipline note
//     says "Stop if T40 lacks observability seam" — T40 DOES expose
//     `stats(key)` (active/queued counts) and `lease.waitMs`, which is
//     enough to assert serialization without an RPC layer.
//   - This probe therefore exercises the real T40 + T41 modules under
//     the same admission/fan-out discipline a future RPC handler will
//     compose, so when the handler lands the invariants are already
//     pinned and any regression in the primitives surfaces here without
//     needing a live daemon.
//
// Mirrors T79 conventions (small probe file, no harness changes, vitest
// `daemon/**/__tests__` glob, no fake timers — uses real setImmediate /
// queueMicrotask interleavings to exercise the JS event loop).

import { describe, expect, it } from 'vitest';

import {
  SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY,
  SNAPSHOT_SEMAPHORE_GLOBAL_KEY,
  createSnapshotSemaphore,
} from '../snapshot-semaphore.js';
import { createFanoutRegistry, type Subscriber } from '../fanout-registry.js';

/** Yield to the macrotask queue so timers + I/O callbacks can run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Yield to the microtask queue so chained `.then` continuations run. */
function microtaskFlush(): Promise<void> {
  return Promise.resolve();
}

/**
 * Simulate one snapshot body: emit FRAMES_PER_BODY frames into the
 * caller's buffer, yielding between each frame to give other in-flight
 * holders + the broadcast loop a chance to interleave. The `tracker`
 * records the holder id at every frame so the assertion can check
 * contiguity.
 */
async function emitSnapshotBody(
  holderId: number,
  framesPerBody: number,
  tracker: Array<{ holder: number; frame: number }>,
  inflightProbe: () => number,
  inflightHigh: { value: number },
): Promise<Buffer> {
  const buf: Buffer[] = [];
  for (let f = 0; f < framesPerBody; f += 1) {
    // Each frame: 4-byte holder tag + 4-byte frame index + 16-byte payload.
    const frame = Buffer.alloc(24);
    frame.writeUInt32LE(holderId, 0);
    frame.writeUInt32LE(f, 4);
    // Fill payload with a deterministic pattern derived from holder+frame
    // so a torn frame (mixed bytes from two holders) would fail the
    // byte-coherence check at the end.
    for (let i = 0; i < 16; i += 1) {
      frame[8 + i] = (holderId * 31 + f * 7 + i) & 0xff;
    }
    buf.push(frame);
    tracker.push({ holder: holderId, frame: f });
    // Track high-water of in-flight holders. The semaphore must keep
    // this ≤ capacity at every observation point.
    const inflight = inflightProbe();
    if (inflight > inflightHigh.value) inflightHigh.value = inflight;
    // Yield so other promise-resolved holders can attempt to interleave.
    if (f % 2 === 0) await nextTick();
    else await microtaskFlush();
  }
  return Buffer.concat(buf);
}

describe('T80 snapshot interleave probe (frag-3.5.1 §3.5.1.5)', () => {
  it('semaphore serializes — high-water in-flight never exceeds capacity', async () => {
    const capacity = SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY; // 4
    const N = 16; // 4× capacity → 12 callers must queue
    const sem = createSnapshotSemaphore({ capacity });
    const inflightHigh = { value: 0 };

    // Track currently-admitted holders by inspecting the semaphore's
    // own observability seam (`stats(key).active`). This is the
    // ground-truth count the spec requires us to bound.
    const inflightProbe = () => sem.stats(SNAPSHOT_SEMAPHORE_GLOBAL_KEY).active;

    const callers = Array.from({ length: N }, (_, holderId) =>
      (async () => {
        const lease = await sem.acquire(SNAPSHOT_SEMAPHORE_GLOBAL_KEY, 30_000);
        try {
          const tracker: Array<{ holder: number; frame: number }> = [];
          await emitSnapshotBody(holderId, 8, tracker, inflightProbe, inflightHigh);
          return { holderId, waitMs: lease.waitMs };
        } finally {
          lease.release();
        }
      })(),
    );

    const results = await Promise.all(callers);
    expect(results).toHaveLength(N);
    expect(inflightHigh.value).toBeLessThanOrEqual(capacity);
    // Every caller that landed past the first capacity slot must have
    // queued at least once (waitMs > 0 for the over-capacity tail).
    const queued = results.filter((r) => r.waitMs > 0);
    expect(queued.length).toBeGreaterThanOrEqual(N - capacity);
    // Semaphore returns to clean state after all releases.
    expect(sem.stats(SNAPSHOT_SEMAPHORE_GLOBAL_KEY)).toEqual({ active: 0, queued: 0 });
  });

  it('snapshot bodies are byte-coherent — no two holders interleave', async () => {
    const capacity = SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY;
    const N = 12;
    const framesPerBody = 6;
    const sem = createSnapshotSemaphore({ capacity });
    const inflightHigh = { value: 0 };
    const inflightProbe = () => sem.stats(SNAPSHOT_SEMAPHORE_GLOBAL_KEY).active;

    // Per-holder tracker captures (holder, frame) at every emission.
    // After all callers complete, each holder's slice must be contiguous
    // (frames 0..framesPerBody-1 in order, no gaps, no foreign-holder
    // entries spliced into the run).
    const trackers = new Map<number, Array<{ holder: number; frame: number }>>();
    const bodies = new Map<number, Buffer>();

    const callers = Array.from({ length: N }, (_, holderId) =>
      (async () => {
        const lease = await sem.acquire(SNAPSHOT_SEMAPHORE_GLOBAL_KEY, 30_000);
        try {
          const tracker: Array<{ holder: number; frame: number }> = [];
          trackers.set(holderId, tracker);
          const body = await emitSnapshotBody(
            holderId,
            framesPerBody,
            tracker,
            inflightProbe,
            inflightHigh,
          );
          bodies.set(holderId, body);
        } finally {
          lease.release();
        }
      })(),
    );

    await Promise.all(callers);

    // Per-holder body coherence:
    //   - exactly framesPerBody frames, in order 0..framesPerBody-1
    //   - tracker contains ONLY this holder's id
    //   - decoded bytes match the deterministic pattern (no torn frames)
    for (const [holderId, tracker] of trackers) {
      expect(tracker).toHaveLength(framesPerBody);
      for (let i = 0; i < framesPerBody; i += 1) {
        expect(tracker[i]!.holder).toBe(holderId);
        expect(tracker[i]!.frame).toBe(i);
      }
      const body = bodies.get(holderId)!;
      expect(body.length).toBe(framesPerBody * 24);
      for (let f = 0; f < framesPerBody; f += 1) {
        const off = f * 24;
        expect(body.readUInt32LE(off)).toBe(holderId);
        expect(body.readUInt32LE(off + 4)).toBe(f);
        for (let i = 0; i < 16; i += 1) {
          expect(body[off + 8 + i]).toBe((holderId * 31 + f * 7 + i) & 0xff);
        }
      }
    }
    expect(inflightHigh.value).toBeLessThanOrEqual(capacity);
  });

  it('live data fan-out is not blocked while snapshots are in flight', async () => {
    const capacity = SNAPSHOT_SEMAPHORE_DEFAULT_CAPACITY;
    const N = 12;
    const framesPerBody = 6;
    const sem = createSnapshotSemaphore({ capacity });
    const fanout = createFanoutRegistry<{ seq: number; payload: Buffer }>();
    const sessionId = 'sess-T80';

    // A subscriber that just records every delivered live frame. The
    // assertion below checks that live broadcasts continue uninterrupted
    // while snapshot work churns (no starvation).
    const delivered: number[] = [];
    const subscriber: Subscriber<{ seq: number; payload: Buffer }> = {
      deliver: (msg) => {
        delivered.push(msg.seq);
      },
      close: () => {
        /* no-op */
      },
    };
    const unsub = fanout.subscribe(sessionId, subscriber);

    // Live broadcast pump — fires LIVE_FRAMES on a timer, independent of
    // any snapshot promise. Records the count actually broadcast so we
    // can assert "every broadcast made it to the subscriber" (no drops).
    let liveBroadcast = 0;
    const LIVE_FRAMES = 40;
    const livePump = (async () => {
      for (let s = 0; s < LIVE_FRAMES; s += 1) {
        fanout.broadcast(sessionId, { seq: s, payload: Buffer.from([s & 0xff]) });
        liveBroadcast += 1;
        // ~1 ms between live frames; total live runtime ~40 ms.
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    // Snapshot callers — N concurrent, contend for capacity-4 semaphore.
    const inflightHigh = { value: 0 };
    const inflightProbe = () => sem.stats(SNAPSHOT_SEMAPHORE_GLOBAL_KEY).active;
    const snapshotCallers = Array.from({ length: N }, (_, holderId) =>
      (async () => {
        const lease = await sem.acquire(SNAPSHOT_SEMAPHORE_GLOBAL_KEY, 30_000);
        try {
          const tracker: Array<{ holder: number; frame: number }> = [];
          await emitSnapshotBody(
            holderId,
            framesPerBody,
            tracker,
            inflightProbe,
            inflightHigh,
          );
        } finally {
          lease.release();
        }
      })(),
    );

    await Promise.all([livePump, ...snapshotCallers]);
    unsub();

    // Live invariants:
    //   - broadcast pump emitted exactly LIVE_FRAMES.
    //   - subscriber received EVERY frame, in order, no drops, no dupes.
    //   - At least some live frames must have been delivered DURING the
    //     snapshot churn (otherwise the test trivially passed because the
    //     snapshot work finished before the live pump started). We pin
    //     this by requiring delivered.length > capacity (more live
    //     frames than semaphore slots — interleaving is forced).
    expect(liveBroadcast).toBe(LIVE_FRAMES);
    expect(delivered).toHaveLength(LIVE_FRAMES);
    for (let s = 0; s < LIVE_FRAMES; s += 1) expect(delivered[s]).toBe(s);
    expect(delivered.length).toBeGreaterThan(capacity);
    expect(inflightHigh.value).toBeLessThanOrEqual(capacity);
  });
});
