// Focused tests for the daemon-side SessionWatcher pipeline (#106 A3).
//
// Covers the three slice-acceptance points called out in the task brief:
//   1. file event triggers a snapshot/delta update (FileSource → state
//      machine → registry → subscriber).
//   2. multiple subscribers all receive the same broadcast (fan-out
//      registry correctness).
//   3. reconnect resume — a fresh subscribe with `fromBootNonce` mismatch
//      emits `boot_changed` + snapshot, while same-nonce + fromSeq>0
//      yields a `gap=true` snapshot (per connectHandler.ts §3).
//
// We avoid full fs.watch round-trip (race-prone on Windows + slow); the
// FileSource is exercised in its own focused test (it's a byte-for-byte
// port of electron/sessionWatcher/fileSource.ts which already has
// coverage). Here we drive the state machine + connectHandler directly
// through an in-process stream sink.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStateMachine, type SessionEventPojo } from '../sessionState.js';
import { createSessionSubscriberRegistry } from '../subscriberRegistry.js';
import {
  handleSubscribeSessionEvents,
  type SubscribeContext,
  type SubscribeStream,
  type SubscribeEndReason,
} from '../connectHandler.js';
import { FileSource } from '../fileSource.js';

function makeStream(): {
  events: SessionEventPojo[];
  endReasons: SubscribeEndReason[];
  stream: SubscribeStream;
} {
  const events: SessionEventPojo[] = [];
  const endReasons: SubscribeEndReason[] = [];
  const stream: SubscribeStream = {
    push(evt) {
      events.push(evt);
    },
    end(reason) {
      endReasons.push(reason);
    },
  };
  return { events, endReasons, stream };
}

function makeWiring(opts: { bootNonce: string }): {
  sm: SessionStateMachine;
  registry: ReturnType<typeof createSessionSubscriberRegistry>;
  ctx: SubscribeContext;
} {
  const registry = createSessionSubscriberRegistry();
  const sm = new SessionStateMachine({
    emit: (evt) => registry.broadcast(evt),
    bootNonce: opts.bootNonce,
  });
  const ctx: SubscribeContext = {
    stateMachine: sm,
    registry,
    bootNonce: opts.bootNonce,
    // Use a no-op interval so the heartbeat timer never fires in tests.
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  return { sm, registry, ctx };
}

describe('daemon SessionWatcher slice (#106)', () => {
  describe('state-machine + registry: file event triggers update', () => {
    it('emits snapshot then delta after a state mutation reaches subscriber', () => {
      const { sm, ctx } = makeWiring({ bootNonce: 'BOOT_A' });
      sm.initSession({ sessionId: 'sess-1', cwd: '/work' });

      const { events, stream } = makeStream();
      handleSubscribeSessionEvents(
        { sessionId: 'sess-1', fromSeq: 0, fromBootNonce: 'BOOT_A', heartbeatMs: 0 },
        stream,
        ctx,
      );

      // Initial subscribe → exactly one snapshot event, no gap, seq=0.
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('snapshot');
      if (events[0]?.kind === 'snapshot') {
        expect(events[0].snapshot.sessionId).toBe('sess-1');
        expect(events[0].snapshot.seq).toBe(0);
        expect(events[0].gap).toBe(false);
      }

      // Now mutate state — simulating what FileSource → classify →
      // applyState would do once a JSONL frame lands.
      sm.applyState('sess-1', 'idle');

      expect(events).toHaveLength(2);
      expect(events[1]?.kind).toBe('delta');
      if (events[1]?.kind === 'delta') {
        expect(events[1].seq).toBe(1);
        expect(events[1].change.kind).toBe('state_changed');
      }
    });

    it('FileSource produces ticks for newly-created files (smoke)', async () => {
      // End-to-end smoke against the producer: write a JSONL file, watch
      // it, expect at least one tick. Keeps fs.watch in coverage without
      // the flakiness of asserting exact tick counts on Windows.
      const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ccsm-fs-'));
      try {
        const jsonlPath = path.join(tmp, 'session.jsonl');
        await fs.promises.writeFile(jsonlPath, '');
        const ticks: Array<{ sid: string; text: string }> = [];
        const src = new FileSource((t) => {
          ticks.push({ sid: t.sid, text: t.text });
        });
        src.start('sess-1', jsonlPath, tmp);
        // The initial scheduleRead is on a 0-ms timer, so wait one macro-
        // task to let it fire.
        await new Promise((r) => setTimeout(r, 50));
        await fs.promises.appendFile(jsonlPath, '{"type":"user"}\n');
        await new Promise((r) => setTimeout(r, 200));
        src.stopAll();
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.some((t) => t.sid === 'sess-1')).toBe(true);
      } finally {
        await fs.promises.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('multiple subscribers all receive the same broadcast', () => {
    it('fan-out delivers each delta to every per-session subscriber', () => {
      const { sm, ctx } = makeWiring({ bootNonce: 'BOOT_B' });
      sm.initSession({ sessionId: 'sid-x', cwd: '/w' });

      const a = makeStream();
      const b = makeStream();
      const c = makeStream();

      handleSubscribeSessionEvents(
        { sessionId: 'sid-x', fromSeq: 0, fromBootNonce: 'BOOT_B', heartbeatMs: 0 },
        a.stream,
        ctx,
      );
      handleSubscribeSessionEvents(
        { sessionId: 'sid-x', fromSeq: 0, fromBootNonce: 'BOOT_B', heartbeatMs: 0 },
        b.stream,
        ctx,
      );
      // Firehose subscriber: filter='' → also receives every event.
      handleSubscribeSessionEvents(
        { sessionId: '', fromSeq: 0, fromBootNonce: 'BOOT_B', heartbeatMs: 0 },
        c.stream,
        ctx,
      );

      // Each per-session subscribe emitted one snapshot; firehose emitted
      // one snapshot per known session (just sid-x).
      expect(a.events.filter((e) => e.kind === 'snapshot')).toHaveLength(1);
      expect(b.events.filter((e) => e.kind === 'snapshot')).toHaveLength(1);
      expect(c.events.filter((e) => e.kind === 'snapshot')).toHaveLength(1);

      sm.applyTitle('sid-x', 'hello');

      const deltaCount = (s: typeof a) =>
        s.events.filter((e) => e.kind === 'delta').length;
      expect(deltaCount(a)).toBe(1);
      expect(deltaCount(b)).toBe(1);
      expect(deltaCount(c)).toBe(1);
    });

    it('a throwing subscriber does not poison its peers', () => {
      const { sm, registry } = makeWiring({ bootNonce: 'BOOT_C' });
      sm.initSession({ sessionId: 's', cwd: '/' });

      const seen: string[] = [];
      registry.subscribe('s', {
        deliver() {
          throw new Error('boom');
        },
        close() {},
      });
      registry.subscribe('s', {
        deliver(evt) {
          seen.push(evt.kind);
        },
        close() {},
      });

      sm.applyState('s', 'idle');
      // The healthy subscriber still saw the delta.
      expect(seen).toEqual(['delta']);
    });
  });

  describe('reconnect resume', () => {
    it('boot-nonce mismatch emits boot_changed + fresh snapshot (gap=false)', () => {
      const { sm, ctx } = makeWiring({ bootNonce: 'BOOT_NEW' });
      sm.initSession({ sessionId: 's', cwd: '/' });
      sm.applyState('s', 'idle'); // seq → 1

      const { events, stream } = makeStream();
      handleSubscribeSessionEvents(
        { sessionId: 's', fromSeq: 5, fromBootNonce: 'BOOT_OLD', heartbeatMs: 0 },
        stream,
        ctx,
      );

      // Mismatch path: boot_changed first, then snapshot (gap=false because
      // bootMismatch resets the gap flag — see connectHandler.ts ~L191).
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]?.kind).toBe('boot_changed');
      if (events[0]?.kind === 'boot_changed') {
        expect(events[0].bootNonce).toBe('BOOT_NEW');
        expect(events[0].snapshotPending).toBe(true);
      }
      expect(events[1]?.kind).toBe('snapshot');
      if (events[1]?.kind === 'snapshot') {
        expect(events[1].gap).toBe(false);
        expect(events[1].snapshot.seq).toBe(1);
      }
    });

    it('same-nonce + fromSeq>0 → snapshot with gap=true (history replay TODO)', () => {
      const { sm, ctx } = makeWiring({ bootNonce: 'BOOT_K' });
      sm.initSession({ sessionId: 's', cwd: '/' });
      sm.applyState('s', 'idle');
      sm.applyState('s', 'running');

      const { events, stream } = makeStream();
      handleSubscribeSessionEvents(
        { sessionId: 's', fromSeq: 1, fromBootNonce: 'BOOT_K', heartbeatMs: 0 },
        stream,
        ctx,
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('snapshot');
      if (events[0]?.kind === 'snapshot') {
        expect(events[0].gap).toBe(true);
        // seq reflects the latest state, not fromSeq.
        expect(events[0].snapshot.seq).toBe(2);
      }
    });

    it('per-session subscribe to unknown sessionId ends with session-removed', () => {
      const { ctx } = makeWiring({ bootNonce: 'BOOT_Z' });
      const { events, endReasons, stream } = makeStream();
      handleSubscribeSessionEvents(
        { sessionId: 'no-such', fromSeq: 0, fromBootNonce: 'BOOT_Z', heartbeatMs: 0 },
        stream,
        ctx,
      );
      expect(events).toHaveLength(0);
      expect(endReasons).toHaveLength(1);
      expect(endReasons[0]?.kind).toBe('session-removed');
    });

    it('caller cancel via returned hook drives end with caller-cancel', () => {
      const { sm, ctx } = makeWiring({ bootNonce: 'BOOT_Q' });
      sm.initSession({ sessionId: 'q', cwd: '/' });
      const { endReasons, stream } = makeStream();
      const cancel = handleSubscribeSessionEvents(
        { sessionId: 'q', fromSeq: 0, fromBootNonce: 'BOOT_Q', heartbeatMs: 0 },
        stream,
        ctx,
      );
      cancel();
      expect(endReasons).toEqual([{ kind: 'caller-cancel' }]);
    });
  });
});
