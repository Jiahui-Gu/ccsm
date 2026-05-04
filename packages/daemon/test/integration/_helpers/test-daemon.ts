// packages/daemon/test/integration/_helpers/test-daemon.ts
//
// T8.9 — shared bring-up helpers for the per-RPC integration spec
// family (connect-roundtrip, pty-attach-stream, pty-reattach,
// pty-too-far-behind, pty-sendinput, pty-resize).
//
// Re-exports `startHarness` / `newRequestMeta` / `TEST_PRINCIPAL_KEY`
// from `../harness.ts` so the new specs do not have to thread two
// different bring-up modules. Adds:
//
//   - `FakeEmitter` — mirrors `pty-host/PtySessionEmitter` (PR #1027)
//     for the surface the Attach handler reads. Lifted verbatim from
//     `src/rpc/pty-attach.spec.ts` so the unit-test fake and the
//     integration fake stay byte-identical (a single drift on the
//     publish/subscribe contract surfaces in both layers at once).
//
//   - `attachClientHelper(client, sessionId, opts)` — wraps the
//     `client.attach(...)` async-iterable in a `{ next(), return() }`
//     pair so each spec body stays narrowly focused on the assertion
//     (snapshot-then-deltas / OutOfRange / sendInput round-trip / etc.)
//     without re-implementing iterator boilerplate.
//
//   - `makeAttachReq` / `makeSnapshot` / `makeDelta` — small builders
//     that hide the proto / in-memory fixture shape behind a single
//     `{sessionId, sinceSeq}` keyword argument. Kept here (not in
//     each spec) so a v0.4 schema add to `AttachRequest` does not
//     need to be threaded through six call sites.
//
// Reuse-not-rebuild rationale (Layer 1 §1):
//   - `startHarness` already wires the canonical Listener-A test seam:
//     ephemeral 127.0.0.1 h2c port + bearer-token PeerInfo deposit +
//     real `peerCredAuthInterceptor` so handlers see a populated
//     PRINCIPAL_KEY. The boot-end-to-end spec
//     (`daemon-boot-end-to-end.spec.ts`) cannot stand in here because
//     production wire-up still routes `PtyService.SendInput`,
//     `Resize`, `CheckClaudeAvailable` to `Code.Unimplemented` (see
//     `rpc/router.ts:registerPtyService` comment). The boot-e2e file
//     deliberately refuses to reverse-assert those Unimplemented
//     branches (file header comment §2: "Stuffing reverse-assertions
//     for the unwired ~10 here would lock in transitional
//     Unimplemented behavior we expect to delete in 2 weeks — net
//     negative"). Per-RPC integration coverage (ch12 §3) instead
//     wires the handlers each spec needs, identically to the
//     `settings-roundtrip.spec.ts` pattern that ships today.
//
//   - `FakeEmitter` is duplicated rather than imported from
//     `src/rpc/pty-attach.spec.ts` because that file is a co-located
//     unit spec — vitest picks it up but it is NOT a public test-
//     helper module. Lifting the class to `_helpers/` is the smaller
//     change than promoting a co-located spec into a public surface.

import { create } from '@bufbuild/protobuf';
import {
  type CallOptions,
  type Client,
  ConnectError,
} from '@connectrpc/connect';

import {
  AttachRequestSchema,
  type PtyFrame,
  type PtyService,
  RequestMetaSchema,
} from '@ccsm/proto';

import type {
  DeltaInMem,
  PtySnapshotInMem,
} from '../../../src/pty-host/attach-decider.js';
import type {
  PtyEmitterEvent,
  PtyEmitterListener,
  PtySessionEmitterLike,
} from '../../../src/rpc/pty-attach.js';

export {
  newRequestMeta,
  startHarness,
  TEST_PRINCIPAL_KEY,
  type Harness,
  type StartOptions,
  type RouterSetup,
} from '../harness.js';

// ---------------------------------------------------------------------------
// FakeEmitter — verbatim mirror of the unit-test fake in
// `src/rpc/pty-attach.spec.ts`. Lifting this class here lets the
// integration spec family construct emitters without depending on a
// co-located unit-test file.
// ---------------------------------------------------------------------------

export class FakeEmitter implements PtySessionEmitterLike {
  readonly sessionId: string;
  readonly capacity: number;
  #snapshot: PtySnapshotInMem | null = null;
  #maxSeq: bigint = 0n;
  readonly #ring: DeltaInMem[] = [];
  readonly #subs: Set<PtyEmitterListener> = new Set();
  #closed = false;
  // Resize / SendInput observers — populated by spec-side handlers. Kept
  // on the emitter (not module-level) so a single sessionId routes its
  // observed wire calls back to its emitter without a second registry.
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly inputs: Uint8Array[] = [];

  constructor(sessionId: string, capacity = 4096) {
    this.sessionId = sessionId;
    this.capacity = capacity;
  }

  currentSnapshot(): PtySnapshotInMem | null {
    return this.#snapshot;
  }
  currentMaxSeq(): bigint {
    return this.#maxSeq;
  }
  oldestRetainedSeq(): bigint {
    if (this.#maxSeq === 0n) return 0n;
    const cap = BigInt(this.capacity);
    const candidate = this.#maxSeq - cap + 1n;
    return candidate > 1n ? candidate : 1n;
  }
  deltasSince(sinceSeq: bigint): readonly DeltaInMem[] | 'out-of-window' {
    if (this.#maxSeq === 0n) {
      return sinceSeq === 0n ? [] : 'out-of-window';
    }
    if (sinceSeq < this.oldestRetainedSeq()) return 'out-of-window';
    if (sinceSeq >= this.#maxSeq) return [];
    return this.#ring.filter((d) => d.seq > sinceSeq);
  }
  subscribe(listener: PtyEmitterListener): () => void {
    if (this.#closed) {
      try {
        listener({ kind: 'closed', reason: 'pty.session_destroyed' });
      } catch {
        /* swallow */
      }
      return () => {};
    }
    this.#subs.add(listener);
    return () => {
      this.#subs.delete(listener);
    };
  }
  isClosed(): boolean {
    return this.#closed;
  }
  subscriberCount(): number {
    return this.#subs.size;
  }

  publishSnapshot(snap: PtySnapshotInMem): void {
    if (this.#closed) return;
    this.#snapshot = snap;
    this.#broadcast({ kind: 'snapshot', snapshot: snap });
  }
  publishDelta(delta: DeltaInMem): void {
    if (this.#closed) return;
    if (delta.seq <= this.#maxSeq) {
      throw new Error(`non-monotonic seq ${delta.seq} <= ${this.#maxSeq}`);
    }
    this.#ring.push(delta);
    if (this.#ring.length > this.capacity) {
      this.#ring.shift();
    }
    this.#maxSeq = delta.seq;
    this.#broadcast({ kind: 'delta', delta });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const event: PtyEmitterEvent = {
      kind: 'closed',
      reason: 'pty.session_destroyed',
    };
    const subs = [...this.#subs];
    this.#subs.clear();
    for (const l of subs) {
      try {
        l(event);
      } catch {
        /* swallow */
      }
    }
  }
  publishSessionStateChanged(args: {
    readonly state: 'RUNNING' | 'DEGRADED';
    readonly reason: string;
    readonly sinceUnixMs: number;
  }): void {
    if (this.#closed) return;
    this.#broadcast({
      kind: 'session-state-changed',
      state: args.state,
      reason: args.reason,
      lastSeq: this.#maxSeq,
      sinceUnixMs: args.sinceUnixMs,
    });
  }

  #broadcast(event: PtyEmitterEvent): void {
    const subs = [...this.#subs];
    for (const l of subs) {
      try {
        l(event);
      } catch {
        /* swallow */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture builders (kept tiny — these are the shapes every spec touches).
// ---------------------------------------------------------------------------

export function makeSnapshot(
  baseSeq: bigint,
  geometry: { cols: number; rows: number } = { cols: 80, rows: 24 },
  screen: Uint8Array = new Uint8Array([1, 2]),
): PtySnapshotInMem {
  return {
    baseSeq,
    geometry,
    screenState: screen,
    schemaVersion: 1,
  };
}

export function makeDelta(
  seq: bigint,
  payload: Uint8Array = new Uint8Array([0xaa]),
): DeltaInMem {
  return { seq, tsUnixMs: 1700000000000n + seq, payload };
}

export function makeAttachReq(opts: {
  readonly sessionId: string;
  readonly sinceSeq?: bigint;
  readonly requiresAck?: boolean;
}): ReturnType<typeof create<typeof AttachRequestSchema>> {
  return create(AttachRequestSchema, {
    meta: create(RequestMetaSchema, {
      requestId: '11111111-2222-3333-4444-555555555555',
      clientVersion: '0.3.0-test',
      clientSendUnixMs: BigInt(Date.now()),
    }),
    sessionId: opts.sessionId,
    sinceSeq: opts.sinceSeq ?? 0n,
    requiresAck: opts.requiresAck ?? false,
  });
}

// ---------------------------------------------------------------------------
// Attach iterator helper — wraps `client.attach(req)` with the typical
// drain pattern the specs share. Returns the iterator + a `nextOrThrow()`
// convenience that surfaces a `ConnectError` from the daemon as a thrown
// value (rather than masquerading as `done: true`).
// ---------------------------------------------------------------------------

export interface AttachStream {
  readonly next: () => Promise<IteratorResult<PtyFrame>>;
  readonly return: () => Promise<void>;
  /** Drain frames until the stream throws; returns the ConnectError. */
  readonly drainExpectError: () => Promise<ConnectError>;
}

export function attachClientHelper(
  client: Client<typeof PtyService>,
  opts: {
    readonly sessionId: string;
    readonly sinceSeq?: bigint;
    readonly requiresAck?: boolean;
    readonly callOptions?: CallOptions;
  },
): AttachStream {
  const iter = client.attach(makeAttachReq(opts), opts.callOptions);
  const ai = iter[Symbol.asyncIterator]();
  return {
    next: () => ai.next() as Promise<IteratorResult<PtyFrame>>,
    return: async () => {
      try {
        await ai.return?.(undefined);
      } catch {
        /* swallow — abort during return is acceptable */
      }
    },
    drainExpectError: async () => {
      try {
        // Bound the loop: a misbehaving handler that yields forever
        // would otherwise pin the suite. 1024 frames covers every
        // assertion in this family (capacity-overflow uses a known
        // small bound; happy paths terminate after 1-3 frames).
        for (let i = 0; i < 1024; i += 1) {
          const r = await ai.next();
          if (r.done === true) {
            throw new Error(
              'expected ConnectError on attach stream; stream ended cleanly',
            );
          }
        }
        throw new Error(
          'expected ConnectError on attach stream; drained 1024 frames without error',
        );
      } catch (err) {
        if (err instanceof ConnectError) return err;
        // Connect-ES surfaces some failures as plain Error before the
        // ConnectError mapping fires; normalise.
        return ConnectError.from(err);
      }
    },
  };
}
