// packages/daemon/test/integration/rpc/pty-attach-stream.spec.ts
//
// T8.9 — integration spec: PtyService.Attach happy + error paths.
//
// Spec ch12 §3:
//   "pty-attach-stream.spec.ts — PtyService.Attach happy path: create
//    session with a deterministic test claude (`claude-sim
//    --simulate-workload` short variant); Attach with `since_seq=0`;
//    assert receive snapshot then deltas; replay and compare to
//    daemon-side terminal state."
//
// Spec adaptation note:
//   The full `claude-sim --simulate-workload` harness lives in
//   `packages/daemon/test/integration/pty-soak-{1h,10m}.spec.ts` (T8.4
//   ship-gate (c)) — that is where the OS-spawn-claude-pty branch is
//   exercised. T8.9's per-RPC integration coverage instead drives the
//   wire-level Attach contract through a `FakeEmitter` (PR #1027's
//   shape) so the assertion is "the PtyService.Attach handler streams
//   snapshot then deltas in the right order over the real Connect /
//   HTTP/2 listener" without coupling to xterm-headless replay (already
//   covered by `pty/snapshot-codec.spec.ts` + `pty/replay-invariant.
//   property.spec.ts`). The byte-equality replay assertion the spec
//   text mentions is the load-bearing gate for the soak; for the
//   per-RPC happy path the wire ordering + payload bytes match are
//   sufficient.
//
// Coverage:
//   - Happy: since_seq=0 → snapshot frame, then deltas yielded in
//     monotonic seq order.
//   - Error: unknown sessionId → Code.NotFound + ErrorDetail
//     `pty.session_not_found` (spec §1).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';

import {
  ErrorDetailSchema,
  PtyService,
} from '@ccsm/proto';

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

describe('pty-attach-stream (ch12 §3) — happy path', () => {
  it('since_seq=0 yields snapshot then live deltas in monotonic order', async () => {
    const emitter = new FakeEmitter('sess-attach-happy');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set(emitter.sessionId, emitter);

    const client = harness.makeClient(PtyService);
    const stream = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 0n,
    });

    // Frame 1: snapshot.
    const f1 = await stream.next();
    expect(f1.done).toBe(false);
    expect(f1.value?.kind.case).toBe('snapshot');

    // Schedule live deltas. Publish one, await the wire frame, repeat —
    // a single in-flight publish at a time keeps the assertion
    // deterministic regardless of Connect's flow-control buffering.
    const payloads: number[][] = [
      [0xa1],
      [0xa2, 0xa3],
      [0xa4, 0xa5, 0xa6],
    ];
    for (let i = 0; i < payloads.length; i += 1) {
      const seq = BigInt(i + 1);
      const payload = new Uint8Array(payloads[i]!);
      void Promise.resolve().then(() => emitter.publishDelta(makeDelta(seq, payload)));
      const f = await stream.next();
      expect(f.done).toBe(false);
      expect(f.value?.kind.case).toBe('delta');
      if (f.value?.kind.case !== 'delta') throw new Error('unreachable');
      expect(f.value.kind.value.seq).toBe(seq);
      expect(Array.from(f.value.kind.value.payload)).toEqual(payloads[i]);
    }

    await stream.return();
  });
});

describe('pty-attach-stream (ch12 §3) — error path', () => {
  it('unknown session_id rejects with Code.NotFound + pty.session_not_found', async () => {
    const client = harness.makeClient(PtyService);
    const stream = attachClientHelper(client, {
      sessionId: 'no-such-sess',
      sinceSeq: 0n,
    });
    const err = await stream.drainExpectError();
    expect(err.code).toBe(Code.NotFound);
    expect(readErrorDetail(err)?.code).toBe('pty.session_not_found');
  });
});
