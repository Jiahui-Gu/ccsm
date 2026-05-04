// packages/daemon/test/integration/rpc/pty-too-far-behind.spec.ts
//
// T8.9 — integration spec: PtyService.Attach `too far behind`
// recovery path.
//
// Spec ch12 §3:
//   "pty-too-far-behind.spec.ts — PtyService.Attach error path:
//    simulate falling outside retention window, assert daemon falls
//    back to snapshot."
//
// Spec adaptation note:
//   The decider returns `refused_too_far_behind` (Code.OutOfRange +
//   `pty.attach_too_far_behind`) when `since_seq < oldestRetainedSeq`
//   — the on-the-wire shape is an ERROR, not a silent snapshot
//   replacement (spec `2026-05-04-pty-attach-handler.md` §3.2; the
//   handler errors so the client KNOWS to retry with `since_seq=0`).
//   Spec ch12 §3's "falls back to snapshot" wording describes the
//   client-side recovery sequence: receive OutOfRange, retry attach
//   with `since_seq=0`, receive snapshot. We exercise BOTH legs in
//   the happy path below — the wire error AND the subsequent
//   retry-with-zero that delivers a snapshot.
//
// Coverage:
//   - Happy (recovery loop): attach with since_seq below the window
//     receives OutOfRange; client immediately retries with
//     since_seq=0; receives snapshot frame.
//   - Error (raw error path): attach with since_seq below the window
//     surfaces Code.OutOfRange + ErrorDetail `pty.attach_too_far_behind`
//     with `extra.since_seq` and `extra.oldest_retained_seq` populated
//     (spec §3.2).

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

interface DetailWithExtra {
  readonly code: string;
  readonly extra: { readonly [k: string]: string };
}
function readErrorDetail(err: ConnectError): DetailWithExtra | null {
  const details = err.findDetails(ErrorDetailSchema);
  return (details[0] as DetailWithExtra | undefined) ?? null;
}

// Helper: build an emitter whose ring window cleanly excludes seq=1.
// Capacity 4 + 6 deltas published → ring keeps last 4 → oldest = 3.
function buildOutOfWindowEmitter(): FakeEmitter {
  const e = new FakeEmitter('sess-too-far', /* capacity */ 4);
  e.publishSnapshot(makeSnapshot(0n));
  for (let i = 1n; i <= 6n; i += 1n) e.publishDelta(makeDelta(i));
  return e;
}

describe('pty-too-far-behind (ch12 §3) — happy path: client recovers via since_seq=0 retry', () => {
  it('OutOfRange on the first attach; retry with since_seq=0 delivers a snapshot', async () => {
    const emitter = buildOutOfWindowEmitter();
    registry.set(emitter.sessionId, emitter);

    const client = harness.makeClient(PtyService);

    // Leg 1: attach with since_seq=1 (below oldest retained=3) →
    // OutOfRange.
    const tooBehind = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 1n,
    });
    const err = await tooBehind.drainExpectError();
    expect(err.code).toBe(Code.OutOfRange);

    // Leg 2: client recovery — retry with since_seq=0; daemon yields
    // the snapshot frame (decider verdict `snapshot_then_live`).
    const recovery = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 0n,
    });
    const f = await recovery.next();
    expect(f.done).toBe(false);
    expect(f.value?.kind.case).toBe('snapshot');
    await recovery.return();
  });
});

describe('pty-too-far-behind (ch12 §3) — error path: detail shape pinned', () => {
  it('emits Code.OutOfRange + pty.attach_too_far_behind with since_seq + oldest_retained_seq', async () => {
    const emitter = buildOutOfWindowEmitter();
    registry.set(emitter.sessionId, emitter);

    const client = harness.makeClient(PtyService);
    const stream = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 1n,
    });
    const err = await stream.drainExpectError();
    expect(err.code).toBe(Code.OutOfRange);
    const detail = readErrorDetail(err);
    expect(detail?.code).toBe('pty.attach_too_far_behind');
    // The handler stringifies bigints into the extra map (see
    // pty-attach.ts L624). Pin both fields.
    expect(detail?.extra.since_seq).toBe('1');
    expect(detail?.extra.oldest_retained_seq).toBe('3');
  });
});
