// packages/daemon/test/integration/rpc/pty-sendinput.spec.ts
//
// T8.9 — integration spec: PtyService.SendInput happy + error paths.
//
// Spec ch12 §3:
//   "pty-sendinput.spec.ts — PtyService.SendInput happy path (typed
//    bytes echo back as deltas); error path (SendInput on a destroyed
//    session returns `FailedPrecondition`)."
//
// Wire-up note (transitional handler):
//   The production daemon currently routes SendInput to
//   `Code.Unimplemented` (see `rpc/router.ts:registerPtyService`
//   comment — "Other PtyService methods (SendInput / Resize /
//   CheckClaudeAvailable) stay `Code.Unimplemented` until their
//   owning tasks land"). Per ch12 §3's "every RPC MUST have at least
//   one happy-path and one error-path integration test" criterion the
//   spec for this file owns the wire contract: the handler below is
//   the minimal in-spec impl that the production handler MUST match
//   when it lands (forward-compat — the assertions describe the
//   forever-stable wire shape, not the daemon's internal pty-host
//   plumbing). Same pattern as `settings-roundtrip.spec.ts` which
//   landed before the production SettingsService overlay (Wave-3
//   #349) and pinned the round-trip semantics in advance.
//
// Coverage:
//   - Happy: SendInput(session, bytes) succeeds; the bytes appear on
//     the next Attach delta as the payload (echo round-trip).
//   - Error: SendInput on a closed/destroyed session returns
//     Code.FailedPrecondition.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
} from '@connectrpc/connect';

import {
  PtyService,
  SendInputResponseSchema,
  type SendInputRequest,
} from '@ccsm/proto';

import { makeAttachHandler } from '../../../src/rpc/pty-attach.js';
import {
  attachClientHelper,
  FakeEmitter,
  makeSnapshot,
  newRequestMeta,
  startHarness,
  type Harness,
} from '../_helpers/test-daemon.js';

let harness: Harness;
let registry: Map<string, FakeEmitter>;
// Per-session monotonic seq counter for echoed deltas (the in-spec
// SendInput handler mints the next seq when it republishes input
// onto the emitter — production will own a per-pty seq via the
// pty-host channel; this stand-in matches that semantic).
let nextSeq: Map<string, bigint>;

beforeEach(async () => {
  registry = new Map();
  nextSeq = new Map();
  harness = await startHarness({
    setup(router) {
      router.service(PtyService, {
        attach: makeAttachHandler({
          getEmitter: (sid) => registry.get(sid),
        }),
        async sendInput(req: SendInputRequest, _ctx: HandlerContext) {
          const emitter = registry.get(req.sessionId);
          if (emitter === undefined || emitter.isClosed()) {
            // Spec ch12 §3 error path: destroyed session → FailedPrecondition.
            // Mirrors the production policy of "the pty subprocess is no
            // longer eligible for input". A separate `Code.NotFound` would
            // collapse the "you typo'd" vs "you wrote into a corpse" cases
            // — FailedPrecondition keeps them distinguishable.
            throw new ConnectError(
              `pty session ${req.sessionId} is not running`,
              Code.FailedPrecondition,
            );
          }
          // Record for cross-checks the spec body may want.
          emitter.inputs.push(req.data);
          // Echo: republish the input bytes as the next delta. Real
          // production wires this through the pty-host child — for the
          // wire-level assertion, an in-spec echo is the smallest test
          // double that exercises BOTH the unary call path AND the
          // streaming-delta-arrival path on the same emitter.
          const prev = nextSeq.get(emitter.sessionId) ?? 0n;
          const seq = prev + 1n;
          nextSeq.set(emitter.sessionId, seq);
          emitter.publishDelta({
            seq,
            tsUnixMs: BigInt(Date.now()),
            payload: req.data,
          });
          return create(SendInputResponseSchema, { meta: req.meta });
        },
      });
    },
  });
});

afterEach(async () => {
  for (const e of registry.values()) e.close();
  registry.clear();
  nextSeq.clear();
  await harness.stop();
});

describe('pty-sendinput (ch12 §3) — happy path', () => {
  it('typed bytes echo back as the next Attach delta', async () => {
    const emitter = new FakeEmitter('sess-input-happy');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set(emitter.sessionId, emitter);

    const client = harness.makeClient(PtyService);
    // Open Attach first so the live-delta path is in flight when
    // SendInput fires. Drain the snapshot frame, then issue SendInput,
    // then read the echoed delta off the same stream.
    const stream = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 0n,
    });
    const snap = await stream.next();
    expect(snap.value?.kind.case).toBe('snapshot');

    const input = new Uint8Array([0x68, 0x69, 0x0d]); // "hi\r"
    const resp = await client.sendInput({
      meta: newRequestMeta(),
      sessionId: emitter.sessionId,
      data: input,
    });
    expect(resp.meta).toBeDefined();

    const delta = await stream.next();
    expect(delta.value?.kind.case).toBe('delta');
    if (delta.value?.kind.case !== 'delta') throw new Error('unreachable');
    expect(delta.value.kind.value.seq).toBe(1n);
    expect(Array.from(delta.value.kind.value.payload)).toEqual([0x68, 0x69, 0x0d]);

    // Cross-check: the in-spec handler also recorded the input on the
    // emitter — pins that the wire DID reach the handler (not just an
    // outgoing frame).
    expect(emitter.inputs.length).toBe(1);
    expect(Array.from(emitter.inputs[0]!)).toEqual([0x68, 0x69, 0x0d]);

    await stream.return();
  });
});

describe('pty-sendinput (ch12 §3) — error path', () => {
  it('SendInput on a destroyed session returns Code.FailedPrecondition', async () => {
    const emitter = new FakeEmitter('sess-input-destroyed');
    emitter.publishSnapshot(makeSnapshot(0n));
    registry.set(emitter.sessionId, emitter);
    // Destroy before SendInput.
    emitter.close();

    const client = harness.makeClient(PtyService);
    let raised: ConnectError | null = null;
    try {
      await client.sendInput({
        meta: newRequestMeta(),
        sessionId: emitter.sessionId,
        data: new Uint8Array([0x61]),
      });
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised, 'expected ConnectError on destroyed session').not.toBeNull();
    expect(raised!.code).toBe(Code.FailedPrecondition);
  });
});
