import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FrameType,
  decodeFrame,
  encodeExit,
  encodeFrame,
} from '@ccsm/shared';
import {
  PAUSE_THRESHOLD,
  RECONNECT_DELAYS_MS,
  SCROLLBACK_CAP_BYTES,
  SessionRuntime,
  type SessionRuntimeOptions,
} from '../src/index.js';
import type { HostBase, WsStatus } from '../src/ws/client.js';

// Wave-2 T5 (#688): @ccsm/core session-runtime test suite.
//
// Lifted from packages/frontend/test/session-runtime.test.ts and adapted to
// the new framework-agnostic surface:
//   - new SessionRuntime({ hostBase, statusSink, outputSink?, WebSocketImpl })
//   - statusSink replaces the old `useStore.getState().setSessionStatus`
//   - subscribeOutput preserved for renderer ephemeral listeners
//
// We exercise the runtime through a fake WebSocket impl so no real network
// is involved, and through vitest fake timers so reconnect backoff is
// deterministic. Each `it()` constructs its own SessionRuntime — that's the
// new contract (no module singleton).
//
// Acceptance edges pinned by this file (any regress = fail):
//   - reconnect 5-attempt budget then disconnected (no infinite loop)
//   - scrollback push + 4 MiB cap eviction (FIFO, never drop sole chunk)
//   - PAUSE-RESUME edge-triggered exactly once per crossing
//   - detach idempotency (second detach is no-op)
//   - hasEverAttached: false → true on first 'attached', NEVER reset

// ---- Fake WebSocket -----------------------------------------------------

class FakeWs {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWs[] = [];

  readonly OPEN = FakeWs.OPEN;
  readonly CLOSED = FakeWs.CLOSED;
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  closedByClient = false;

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: CloseEvent) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWs.instances.push(this);
  }

  send(data: ArrayBufferView | ArrayBuffer): void {
    if (data instanceof Uint8Array) {
      this.sent.push(new Uint8Array(data));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
      return;
    }
    this.sent.push(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }

  close(): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.closedByClient = true;
    this.readyState = FakeWs.CLOSED;
    this.onclose?.({ code: 1000, reason: '' } as CloseEvent);
  }

  // Test helpers
  open(): void {
    this.readyState = FakeWs.OPEN;
    this.onopen?.();
  }
  receive(buf: Uint8Array): void {
    this.onmessage?.({
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });
  }
  /** Server-initiated close (no EXIT frame first) — triggers reconnect. */
  serverClose(): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    // Pass a CloseEvent-shaped object so the R-17 close log (Task #45) can
    // read `ev.code`/`ev.reason` without throwing.
    this.onclose?.({ code: 1006, reason: '' } as CloseEvent);
  }
}

const HOST: HostBase = { httpBase: 'http://127.0.0.1:17832' };

interface Harness {
  runtime: SessionRuntime;
  /** All status updates the sink received, in order. */
  statusLog: Array<{ sid: string; status: WsStatus }>;
  /** All outputSink invocations, in order. */
  sinkLog: Array<{ sid: string; payload: Uint8Array | null; seq: number }>;
}

function makeRuntime(extra: Partial<SessionRuntimeOptions> = {}): Harness {
  const statusLog: Harness['statusLog'] = [];
  const sinkLog: Harness['sinkLog'] = [];
  const runtime = new SessionRuntime({
    hostBase: HOST,
    statusSink: (sid, status) => statusLog.push({ sid, status }),
    outputSink: (sid, payload, seq) => sinkLog.push({ sid, payload, seq }),
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    ...extra,
  });
  return { runtime, statusLog, sinkLog };
}

describe('SessionRuntime — per-session scrollback + reconnect (T10/#662, T5/#688)', () => {
  beforeEach(() => {
    FakeWs.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('OUTPUT frames push to scrollback, fan to subscribers + outputSink with seq', () => {
    const { runtime, sinkLog } = makeRuntime();
    const subEvents: Array<{
      sid: string;
      payload: Uint8Array | null;
      seq: number;
    }> = [];
    runtime.subscribeOutput((sid, payload, seq) =>
      subEvents.push({ sid, payload, seq }),
    );

    runtime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();

    const payload = new TextEncoder().encode('hi');
    ws.receive(encodeFrame({ type: FrameType.OUTPUT, seq: 7, payload }));

    const entry = runtime.get('s1')!;
    expect(entry.scrollback).toHaveLength(1);
    expect(new TextDecoder().decode(entry.scrollback[0])).toBe('hi');
    expect(entry.scrollbackBytes).toBe(2);
    expect(entry.lastSeq).toBe(7);
    // Both sink and subscriber see the same chunk + seq.
    expect(subEvents).toHaveLength(1);
    expect(subEvents[0]!.seq).toBe(7);
    expect(new TextDecoder().decode(subEvents[0]!.payload!)).toBe('hi');
    expect(sinkLog).toHaveLength(1);
    expect(sinkLog[0]!.seq).toBe(7);
  });

  it('RESET clears scrollback and notifies listeners with payload=null', () => {
    const { runtime } = makeRuntime();
    const events: Array<{ sid: string; payload: Uint8Array | null }> = [];
    runtime.subscribeOutput((sid, payload) => events.push({ sid, payload }));

    runtime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 5,
        payload: new TextEncoder().encode('old data'),
      }),
    );
    expect(runtime.get('s1')!.scrollbackBytes).toBe(8);

    ws.receive(
      encodeFrame({ type: FrameType.RESET, seq: 99, payload: new Uint8Array(0) }),
    );

    const entry = runtime.get('s1')!;
    expect(entry.scrollback).toEqual([]);
    expect(entry.scrollbackBytes).toBe(0);
    expect(entry.lastSeq).toBe(99);
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toBeNull();
  });

  it('reconnects with ?lastSeq=<n> when ws closes without EXIT', () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    const first = FakeWs.instances[0]!;
    expect(first.url).toContain('sid=s1');
    expect(first.url).not.toContain('lastSeq=');
    first.open();

    first.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 42,
        payload: new TextEncoder().encode('progress'),
      }),
    );
    expect(runtime.get('s1')!.lastSeq).toBe(42);

    first.serverClose();
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeWs.instances).toHaveLength(2);
    expect(FakeWs.instances[1]!.url).toContain('lastSeq=42');
    expect(runtime.get('s1')!.status).toBe('connecting');

    FakeWs.instances[1]!.open();
    expect(runtime.get('s1')!.reconnectAttempts).toBe(0);
    expect(runtime.get('s1')!.status).toBe('attached');
  });

  // ---- ACCEPTANCE EDGE 1: reconnect budget exhaustion -------------------
  it('reconnect 5-attempt budget exhaustion → disconnected, no infinite loop', () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');

    // Five close-then-wait cycles. After the 5th the budget is exhausted.
    for (let i = 0; i < RECONNECT_DELAYS_MS.length; i += 1) {
      const ws = FakeWs.instances[i]!;
      ws.serverClose();
      vi.advanceTimersByTime(RECONNECT_DELAYS_MS[i]!);
    }
    expect(FakeWs.instances).toHaveLength(RECONNECT_DELAYS_MS.length + 1);

    // The 6th close exhausts the budget — no further reconnect scheduled.
    const last = FakeWs.instances[FakeWs.instances.length - 1]!;
    last.serverClose();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(RECONNECT_DELAYS_MS.length + 1);
    expect(runtime.get('s1')!.status).toBe('disconnected');
    expect(runtime.get('s1')!.reconnectTimer).toBeNull();
  });

  it('EXIT finalizes session — no reconnect, scrollback retained', () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 1,
        payload: new TextEncoder().encode('history'),
      }),
    );
    ws.receive(
      encodeFrame({ type: FrameType.EXIT, seq: 2, payload: encodeExit(0) }),
    );

    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(1);
    const entry = runtime.get('s1')!;
    expect(entry.status).toBe('exited');
    expect(entry.scrollbackBytes).toBe(7);
  });

  // ---- ACCEPTANCE EDGE 2: scrollback push + cap -------------------------
  it('scrollback push + 4 MiB cap eviction (FIFO, never drop sole chunk)', () => {
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();

    const ONE_MIB = 1024 * 1024;
    const big = new Uint8Array(ONE_MIB);
    big.fill(0x41);
    for (let i = 1; i <= 6; i += 1) {
      ws.receive(
        encodeFrame({ type: FrameType.OUTPUT, seq: i, payload: big }),
      );
    }
    const entry = runtime.get('s1')!;
    expect(entry.scrollbackBytes).toBeLessThanOrEqual(SCROLLBACK_CAP_BYTES);
    expect(entry.scrollback.length).toBeGreaterThanOrEqual(1);
    expect(entry.scrollback.length).toBeLessThanOrEqual(4);

    // Empty payloads must be ignored (defensive: they shouldn't grow scrollback
    // and shouldn't be subject to eviction either).
    const before = entry.scrollback.length;
    ws.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 100,
        payload: new Uint8Array(0),
      }),
    );
    expect(entry.scrollback.length).toBe(before);
  });

  it('runtime publishes per-sid status into statusSink (replaces zustand call)', () => {
    const { runtime, statusLog } = makeRuntime();
    runtime.attach('s1', 'tok');
    expect(statusLog.at(-1)).toEqual({ sid: 's1', status: 'connecting' });
    FakeWs.instances[0]!.open();
    expect(statusLog.at(-1)).toEqual({ sid: 's1', status: 'attached' });
  });

  // ---- ACCEPTANCE EDGE 3: PAUSE-RESUME edge boundary --------------------
  it('PAUSE-RESUME boundary: triggers exactly once per threshold crossing', () => {
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.sent.length = 0;

    // Cross UP edge: bump pendingWrites to threshold-1 → no PAUSE; one more → PAUSE.
    for (let i = 0; i < PAUSE_THRESHOLD - 1; i += 1) runtime.notePendingWrite('s1');
    expect(ws.sent).toHaveLength(0);
    expect(runtime.get('s1')!.paused).toBe(false);
    runtime.notePendingWrite('s1');
    expect(ws.sent).toHaveLength(1);
    expect(decodeFrame(ws.sent[0]!).type).toBe(FrameType.PAUSE);
    expect(runtime.get('s1')!.paused).toBe(true);

    // Pile on more — STILL exactly one PAUSE total (no spam).
    for (let i = 0; i < 50; i += 1) runtime.notePendingWrite('s1');
    expect(ws.sent).toHaveLength(1);

    // Cross DOWN edge: drain to 1 → no RESUME; final drain → RESUME.
    const total = runtime.get('s1')!.pendingWrites;
    for (let i = 0; i < total - 1; i += 1) runtime.noteWriteFlushed('s1');
    expect(ws.sent).toHaveLength(1);
    expect(runtime.get('s1')!.paused).toBe(true);
    runtime.noteWriteFlushed('s1');
    expect(ws.sent).toHaveLength(2);
    expect(decodeFrame(ws.sent[1]!).type).toBe(FrameType.RESUME);
    expect(runtime.get('s1')!.paused).toBe(false);
    expect(runtime.get('s1')!.pendingWrites).toBe(0);

    // Defensive over-drain: no negative pendingWrites, no extra RESUME.
    runtime.noteWriteFlushed('s1');
    runtime.noteWriteFlushed('s1');
    expect(ws.sent).toHaveLength(2);
    expect(runtime.get('s1')!.pendingWrites).toBe(0);
  });

  // ---- ACCEPTANCE EDGE 4: detach idempotency ----------------------------
  it('detach idempotency — second detach is a no-op, never throws', () => {
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 1,
        payload: new TextEncoder().encode('xyz'),
      }),
    );
    expect(runtime.has('s1')).toBe(true);

    runtime.detach('s1');
    expect(runtime.has('s1')).toBe(false);
    expect(ws.closedByClient).toBe(true);

    // Second detach: must not throw, must remain absent.
    expect(() => runtime.detach('s1')).not.toThrow();
    expect(runtime.has('s1')).toBe(false);

    // Detach on never-known sid: also a no-op.
    expect(() => runtime.detach('does-not-exist')).not.toThrow();
  });

  // ---- ACCEPTANCE EDGE 5: hasEverAttached invariant (#673) --------------
  it('hasEverAttached: false → true on first attached, never reset across reconnect/disconnect', () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    let entry = runtime.get('s1')!;
    expect(entry.hasEverAttached).toBe(false);
    expect(entry.status).toBe('connecting');

    // First open flips to attached → hasEverAttached := true.
    FakeWs.instances[0]!.open();
    entry = runtime.get('s1')!;
    expect(entry.status).toBe('attached');
    expect(entry.hasEverAttached).toBe(true);

    // Server close → connecting (reconnect scheduled) — must NOT reset.
    FakeWs.instances[0]!.serverClose();
    entry = runtime.get('s1')!;
    expect(entry.status).toBe('connecting');
    expect(entry.hasEverAttached).toBe(true);

    // Burn the entire reconnect budget without ever opening successfully.
    for (let i = 1; i <= RECONNECT_DELAYS_MS.length; i += 1) {
      vi.advanceTimersByTime(RECONNECT_DELAYS_MS[i - 1]!);
      // New ws was constructed; close it without opening.
      FakeWs.instances[i]!.serverClose();
    }
    entry = runtime.get('s1')!;
    expect(entry.status).toBe('disconnected');
    // Even after exhaustion → disconnected, the flag must stay true.
    expect(entry.hasEverAttached).toBe(true);
  });

  it('hasEverAttached stays false if ws never reaches attached before detach', () => {
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    // Never call ws.open(). Detach immediately.
    expect(runtime.get('s1')!.hasEverAttached).toBe(false);
    runtime.detach('s1');
    // Re-attach a fresh entry: also starts false.
    runtime.attach('s1', 'tok');
    expect(runtime.get('s1')!.hasEverAttached).toBe(false);
  });

  it('reset() closes all entries and clears subscribers', () => {
    const { runtime } = makeRuntime();
    runtime.attach('s1', 'tok');
    runtime.attach('s2', 'tok');
    expect(runtime.has('s1')).toBe(true);
    expect(runtime.has('s2')).toBe(true);
    runtime.reset();
    expect(runtime.has('s1')).toBe(false);
    expect(runtime.has('s2')).toBe(false);
  });

  it('outputSink is optional — runtime works without it', () => {
    const statusLog: Array<{ sid: string; status: WsStatus }> = [];
    const runtime = new SessionRuntime({
      hostBase: HOST,
      statusSink: (sid, status) => statusLog.push({ sid, status }),
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
    runtime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    expect(() =>
      ws.receive(
        encodeFrame({
          type: FrameType.OUTPUT,
          seq: 1,
          payload: new TextEncoder().encode('hi'),
        }),
      ),
    ).not.toThrow();
    expect(runtime.get('s1')!.scrollbackBytes).toBe(2);
  });
});
