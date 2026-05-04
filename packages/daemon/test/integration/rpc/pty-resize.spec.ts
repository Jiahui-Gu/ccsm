// packages/daemon/test/integration/rpc/pty-resize.spec.ts
//
// T8.9 — integration spec: PtyService.Resize happy + error paths.
//
// Spec ch12 §3:
//   "pty-resize.spec.ts — PtyService.Resize happy path (resize 80×24
//    → 120×40 is observed as a Resize delta + snapshot triggered per
//    chapter 06 §4); error path (resize on a destroyed session
//    returns `FailedPrecondition`)."
//
// Wire-up note (transitional handler):
//   PtyService.Resize is currently `Code.Unimplemented` in the
//   production router (see `pty-sendinput.spec.ts` header for the
//   same context). The handler installed below is the in-spec
//   stand-in that pins the forever-stable wire contract: a Resize
//   call updates the emitter's geometry and triggers a fresh
//   snapshot frame on any active Attach (ch06 §4 — "snapshot
//   triggered per resize"). When the production handler lands, the
//   assertions below describe the wire shape it MUST match.
//
// Coverage:
//   - Happy: resize 80×24 → 120×40 surfaces a new snapshot frame
//     whose `geometry` reflects the new dimensions; the cols / rows
//     round-trip on the wire.
//   - Error: resize on a destroyed session returns
//     Code.FailedPrecondition.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
} from '@connectrpc/connect';

import {
  PtyGeometrySchema,
  PtyService,
  ResizeResponseSchema,
  type ResizeRequest,
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

beforeEach(async () => {
  registry = new Map();
  harness = await startHarness({
    setup(router) {
      router.service(PtyService, {
        attach: makeAttachHandler({
          getEmitter: (sid) => registry.get(sid),
        }),
        async resize(req: ResizeRequest, _ctx: HandlerContext) {
          const emitter = registry.get(req.sessionId);
          if (emitter === undefined || emitter.isClosed()) {
            throw new ConnectError(
              `pty session ${req.sessionId} is not running`,
              Code.FailedPrecondition,
            );
          }
          const cols = req.geometry?.cols ?? 0;
          const rows = req.geometry?.rows ?? 0;
          if (cols <= 0 || rows <= 0) {
            throw new ConnectError(
              'geometry cols + rows MUST be positive',
              Code.InvalidArgument,
            );
          }
          // Record + trigger snapshot per ch06 §4. Re-use baseSeq from
          // the current emitter snapshot so reattach math stays
          // consistent (the in-spec emitter's `currentMaxSeq` does not
          // advance on a snapshot publish, only on deltas — matching
          // the production semantic).
          emitter.resizes.push({ cols, rows });
          emitter.publishSnapshot({
            baseSeq: emitter.currentMaxSeq(),
            geometry: { cols, rows },
            screenState: new Uint8Array([1, 2]),
            schemaVersion: 1,
          });
          return create(ResizeResponseSchema, { meta: req.meta });
        },
      });
    },
  });
});

afterEach(async () => {
  for (const e of registry.values()) e.close();
  registry.clear();
  await harness.stop();
});

describe('pty-resize (ch12 §3) — happy path', () => {
  it('resize 80×24 → 120×40 yields a fresh snapshot frame with the new geometry', async () => {
    const emitter = new FakeEmitter('sess-resize-happy');
    emitter.publishSnapshot(makeSnapshot(0n, { cols: 80, rows: 24 }));
    registry.set(emitter.sessionId, emitter);

    const client = harness.makeClient(PtyService);
    const stream = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 0n,
    });

    // Initial snapshot.
    const initial = await stream.next();
    expect(initial.value?.kind.case).toBe('snapshot');
    if (initial.value?.kind.case === 'snapshot') {
      expect(initial.value.kind.value.geometry?.cols).toBe(80);
      expect(initial.value.kind.value.geometry?.rows).toBe(24);
    }

    // Resize triggers a follow-up snapshot. The Attach handler skips
    // mid-stream snapshots per `pty-attach.ts` "at-most-one snapshot
    // per Attach" rule (spec §2.4), so the wire-level signal of the
    // resize on the open Attach stream is NOT a second snapshot frame
    // here. We assert the unary Resize response succeeded, then open
    // a FRESH Attach to observe the new geometry on the snapshot
    // frame — the same recovery sequence a real Electron client takes
    // (see chapter 08 client wire-up).
    const resp = await client.resize({
      meta: newRequestMeta(),
      sessionId: emitter.sessionId,
      geometry: create(PtyGeometrySchema, { cols: 120, rows: 40 }),
    });
    expect(resp.meta).toBeDefined();
    await stream.return();

    expect(emitter.resizes.length).toBe(1);
    expect(emitter.resizes[0]).toEqual({ cols: 120, rows: 40 });

    // Fresh Attach observes the post-resize geometry on the snapshot.
    const fresh = attachClientHelper(client, {
      sessionId: emitter.sessionId,
      sinceSeq: 0n,
    });
    const post = await fresh.next();
    expect(post.value?.kind.case).toBe('snapshot');
    if (post.value?.kind.case === 'snapshot') {
      expect(post.value.kind.value.geometry?.cols).toBe(120);
      expect(post.value.kind.value.geometry?.rows).toBe(40);
    }
    await fresh.return();
  });
});

describe('pty-resize (ch12 §3) — error path', () => {
  it('resize on a destroyed session returns Code.FailedPrecondition', async () => {
    const emitter = new FakeEmitter('sess-resize-destroyed');
    emitter.publishSnapshot(makeSnapshot(0n, { cols: 80, rows: 24 }));
    registry.set(emitter.sessionId, emitter);
    emitter.close();

    const client = harness.makeClient(PtyService);
    let raised: ConnectError | null = null;
    try {
      await client.resize({
        meta: newRequestMeta(),
        sessionId: emitter.sessionId,
        geometry: create(PtyGeometrySchema, { cols: 100, rows: 30 }),
      });
    } catch (err) {
      raised = ConnectError.from(err);
    }
    expect(raised, 'expected ConnectError on destroyed session').not.toBeNull();
    expect(raised!.code).toBe(Code.FailedPrecondition);
  });
});
