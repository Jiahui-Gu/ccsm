// packages/daemon/test/integration/rpc/pty-reattach.spec.ts
//
// T8.9 — integration spec: PtyService.Attach reattach happy + error.
//
// Spec ch12 §3:
//   "pty-reattach.spec.ts — PtyService.Attach reattach path: record N
//    deltas, disconnect, reattach with `since_seq=N`; assert deltas
//    N+1..M arrive, no duplicates, no gaps."
//
// Coverage:
//   - Happy: record 3 deltas, close stream, reattach with since_seq=3,
//     publish 2 more deltas; assert receives only seq=4 and seq=5
//     (no replay of 1..3, no missing frame).
//   - Error: reattach with `since_seq` strictly greater than the
//     daemon's `currentMaxSeq` rejects with InvalidArgument +
//     `pty.attach_future_seq` (spec §3.4 — protocol violation:
//     client claims a frame the daemon never sent).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';

import { ErrorDetailSchema, PtyService } from '@ccsm/proto';

import { makeAttachHandler } from '../../../src/rpc/pty-attach.js';
import {
  attachClientHelper,
  FakeEmitter,
  makeDelta,
  makeSnapshot,
  startHarness,
  type Harness,
} from '../_helpers/test-daemon.js';

let harness: Harness;
let registry: Map<string, FakeEmitter>;

beforeEach(async () => {
  registry = new Map();
  harness = await startHarness({
    setup(router) {
      router.service(PtyService, {
        attach: makeAttachHandler({
          getEmitter: (sid) => registry.get(sid),
        }),
      });
    },
  });
});

afterEach(async () => {
  for (const e of registry.values()) e.close();
  registry.clear();
  await harness.stop();
});

function readErrorDetail(err: ConnectError): { code: string } | null {
  const details = err.findDetails(ErrorDetailSchema);
  return details[0] ?? null;
}

describe('pty-reattach (ch12 §3) — happy path', () => {
  it('reattach with since_seq=N yields only deltas N+1..M (no dupes, no gaps)', async () => {
    const emitter = new FakeEmitter('sess-reattach', /* capacity */ 4096);
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set(emitter.sessionId, emitter);

    const client = harness.makeClient(PtyService);

    // First attach: drain snapshot, then stream live deltas 1..3 onto
    // the SAME open Attach (the `snapshot_then_live` verdict only
    // forwards LIVE deltas; deltas published before the subscribe
    // would never reach this stream — see `pty-attach.ts:753`).
    const first = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 0n,
    });
    const f0 = await first.next();
    expect(f0.value?.kind.case).toBe('snapshot');
    // Wait until the handler subscribed, then publish three deltas one
    // at a time — drain each frame before publishing the next so the
    // bounded channel stays at depth 1 (deterministic ordering).
    const deadline1 = Date.now() + 5000;
    while (emitter.subscriberCount() === 0 && Date.now() < deadline1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(emitter.subscriberCount()).toBeGreaterThan(0);
    for (let i = 1n; i <= 3n; i += 1n) {
      const payload = new Uint8Array([Number(0xb0n + i)]);
      emitter.publishDelta(makeDelta(i, payload));
      const f = await first.next();
      expect(f.value?.kind.case).toBe('delta');
      if (f.value?.kind.case !== 'delta') throw new Error('unreachable');
      expect(f.value.kind.value.seq).toBe(i);
    }
    await first.return();
    // Allow the server-side handler's abort cleanup to run before the
    // reattach assertion polls subscriberCount (we need the count to
    // start from 0 so the second poll observes the second subscription).
    const cleanupDeadline = Date.now() + 2000;
    while (emitter.subscriberCount() > 0 && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Reattach with since_seq=3. Decider verdict: `deltas_only` with
    // (since, currentMax] = (3, 3] = []. Then live deltas 4 + 5
    // arrive on the wire.
    const second = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 3n,
    });
    // Race guard — wait for the server-side handler to register its
    // subscriber on the emitter before publishing the live deltas.
    // Same poll-vs-fixed-delay rationale as connect-roundtrip's
    // WatchSessions assertion.
    const deadline = Date.now() + 5000;
    while (emitter.subscriberCount() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(emitter.subscriberCount()).toBeGreaterThan(0);

    emitter.publishDelta(makeDelta(4n, new Uint8Array([0xb4])));
    const r4 = await second.next();
    expect(r4.value?.kind.case).toBe('delta');
    if (r4.value?.kind.case !== 'delta') throw new Error('unreachable');
    expect(r4.value.kind.value.seq).toBe(4n);
    expect(Array.from(r4.value.kind.value.payload)).toEqual([0xb4]);

    emitter.publishDelta(makeDelta(5n, new Uint8Array([0xb5])));
    const r5 = await second.next();
    expect(r5.value?.kind.case).toBe('delta');
    if (r5.value?.kind.case !== 'delta') throw new Error('unreachable');
    expect(r5.value.kind.value.seq).toBe(5n);
    expect(Array.from(r5.value.kind.value.payload)).toEqual([0xb5]);

    await second.return();
  });
});

describe('pty-reattach (ch12 §3) — error path', () => {
  it('since_seq > currentMaxSeq rejects InvalidArgument + pty.attach_future_seq', async () => {
    const emitter = new FakeEmitter('sess-reattach-future');
    emitter.publishSnapshot(makeSnapshot(0n));
    emitter.publishDelta(makeDelta(1n));
    registry.set(emitter.sessionId, emitter);

    const client = harness.makeClient(PtyService);
    const stream = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 99n,
    });
    const err = await stream.drainExpectError();
    expect(err.code).toBe(Code.InvalidArgument);
    expect(readErrorDetail(err)?.code).toBe('pty.attach_future_seq');
  });
});
