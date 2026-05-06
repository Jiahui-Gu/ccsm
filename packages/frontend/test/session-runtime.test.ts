import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FrameType,
  decodeFrame,
  encodeExit,
  encodeFrame,
} from '@ccsm/shared';
import {
  sessionRuntime,
  _SCROLLBACK_CAP_BYTES_FOR_TESTING,
  _RECONNECT_DELAYS_MS_FOR_TESTING,
  _PAUSE_THRESHOLD_FOR_TESTING,
} from '../src/session-runtime';
import { useStore } from '../src/store';

// session-runtime.ts test suite (Task #662 / T10).
//
// This is the load-bearing module for T10's contract — per-session ws +
// scrollback + auto-reconnect with lastSeq. We exercise it through a fake
// WebSocket impl (registered via runtime.configure) so no real network is
// involved, and through vitest fake timers so reconnect backoff is
// deterministic.
//
// We import the SINGLETON `sessionRuntime` (not the class) because that is
// the surface the rest of the app uses; calling `.reset()` between tests
// keeps state hermetic.

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
  onclose: (() => void) | null = null;

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
    this.onclose?.();
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
    this.onclose?.();
  }
}

function resetStore(): void {
  useStore.setState({
    token: 'tok',
    sessions: [],
    activeSid: null,
    status: 'idle',
    sessionStatuses: {},
  });
}

describe('session-runtime — per-session scrollback + reconnect (T10 / #662)', () => {
  beforeEach(() => {
    FakeWs.instances = [];
    resetStore();
    sessionRuntime.reset();
    sessionRuntime.configure({
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    });
  });

  afterEach(() => {
    sessionRuntime.reset();
    vi.useRealTimers();
  });

  it('OUTPUT frames are pushed to scrollback and fanned to subscribers', () => {
    const events: Array<{ sid: string; payload: Uint8Array | null }> = [];
    sessionRuntime.subscribeOutput((sid, payload) =>
      events.push({ sid, payload }),
    );

    sessionRuntime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();

    const payload = new TextEncoder().encode('hi');
    ws.receive(
      encodeFrame({ type: FrameType.OUTPUT, seq: 7, payload }),
    );

    const entry = sessionRuntime.get('s1')!;
    expect(entry.scrollback).toHaveLength(1);
    expect(new TextDecoder().decode(entry.scrollback[0])).toBe('hi');
    expect(entry.scrollbackBytes).toBe(2);
    expect(entry.lastSeq).toBe(7);
    expect(events).toHaveLength(1);
    expect(events[0]!.sid).toBe('s1');
    expect(new TextDecoder().decode(events[0]!.payload!)).toBe('hi');
  });

  it('only the active session writes to xterm — non-active sids buffer in scrollback only', () => {
    // We model "active session" as the listener filtering by sid (this is what
    // MainPane does). The runtime fans EVERY sid's bytes to the listener;
    // the listener decides whether to write them. Here we assert that
    // scrollback grows for both sids regardless of which is active.
    const writes: Array<{ sid: string; bytes: number }> = [];
    let activeSid: string | null = 's1';
    sessionRuntime.subscribeOutput((sid, payload) => {
      if (payload === null) return;
      // Mimic MainPane: only the active sid's bytes hit the terminal.
      if (sid === activeSid) writes.push({ sid, bytes: payload.byteLength });
    });

    sessionRuntime.attach('s1', 'tok');
    sessionRuntime.attach('s2', 'tok');
    FakeWs.instances[0]!.open();
    FakeWs.instances[1]!.open();

    FakeWs.instances[0]!.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 1,
        payload: new TextEncoder().encode('aaa'),
      }),
    );
    FakeWs.instances[1]!.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 1,
        payload: new TextEncoder().encode('bbbb'),
      }),
    );

    // Only s1's bytes were rendered, but BOTH sids accumulated scrollback.
    expect(writes).toEqual([{ sid: 's1', bytes: 3 }]);
    expect(sessionRuntime.get('s1')!.scrollbackBytes).toBe(3);
    expect(sessionRuntime.get('s2')!.scrollbackBytes).toBe(4);

    // Switch active to s2, send another chunk on s2 — listener now writes it.
    activeSid = 's2';
    FakeWs.instances[1]!.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 2,
        payload: new TextEncoder().encode('cc'),
      }),
    );
    expect(writes).toEqual([
      { sid: 's1', bytes: 3 },
      { sid: 's2', bytes: 2 },
    ]);
  });

  it('RESET frame clears scrollback and notifies the listener with payload=null', () => {
    const events: Array<{ sid: string; payload: Uint8Array | null }> = [];
    sessionRuntime.subscribeOutput((sid, payload) =>
      events.push({ sid, payload }),
    );

    sessionRuntime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 5,
        payload: new TextEncoder().encode('old data'),
      }),
    );
    expect(sessionRuntime.get('s1')!.scrollbackBytes).toBe(8);

    ws.receive(
      encodeFrame({
        type: FrameType.RESET,
        seq: 99,
        payload: new Uint8Array(0),
      }),
    );

    const entry = sessionRuntime.get('s1')!;
    expect(entry.scrollback).toEqual([]);
    expect(entry.scrollbackBytes).toBe(0);
    expect(entry.lastSeq).toBe(99); // RESET seq becomes the new baseline.
    // Listener got the OUTPUT then a null-payload signal for RESET.
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toBeNull();
  });

  it('detach() closes ws, drops scrollback, and removes the entry', () => {
    sessionRuntime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 1,
        payload: new TextEncoder().encode('xyz'),
      }),
    );
    expect(sessionRuntime.has('s1')).toBe(true);

    sessionRuntime.detach('s1');
    expect(sessionRuntime.has('s1')).toBe(false);
    expect(ws.closedByClient).toBe(true);
  });

  it('reconnects with ?lastSeq=<n> when the ws closes without EXIT', () => {
    vi.useFakeTimers();
    sessionRuntime.attach('s1', 'tok');
    const first = FakeWs.instances[0]!;
    expect(first.url).toContain('sid=s1');
    expect(first.url).not.toContain('lastSeq=');
    first.open();

    // Receive some OUTPUT to advance lastSeq.
    first.receive(
      encodeFrame({
        type: FrameType.OUTPUT,
        seq: 42,
        payload: new TextEncoder().encode('progress'),
      }),
    );
    expect(sessionRuntime.get('s1')!.lastSeq).toBe(42);

    // Simulate server-initiated close — no EXIT frame, so reconnect kicks in.
    first.serverClose();
    // The first reconnect delay is 1000ms.
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeWs.instances).toHaveLength(2);
    const second = FakeWs.instances[1]!;
    expect(second.url).toContain('lastSeq=42');
    // Status should briefly be 'connecting' during the wait.
    expect(sessionRuntime.get('s1')!.status).toBe('connecting');

    // A successful open clears the attempt counter back to 0.
    second.open();
    expect(sessionRuntime.get('s1')!.reconnectAttempts).toBe(0);
    expect(sessionRuntime.get('s1')!.status).toBe('attached');
  });

  it('reconnect backoff caps at 5 attempts then leaves status=disconnected', () => {
    vi.useFakeTimers();
    sessionRuntime.attach('s1', 'tok');

    // Five close-then-wait cycles. After the 5th the budget is exhausted.
    for (let i = 0; i < _RECONNECT_DELAYS_MS_FOR_TESTING.length; i += 1) {
      const ws = FakeWs.instances[i]!;
      ws.serverClose();
      // `serverClose()` triggers handleDisconnect synchronously, which both
      // schedules the next attempt AND increments attempts. Step through
      // exactly the scheduled delay so the next FakeWs is constructed.
      vi.advanceTimersByTime(_RECONNECT_DELAYS_MS_FOR_TESTING[i]!);
    }
    // Five reconnect attempts == one initial + five retries == 6 ws total.
    expect(FakeWs.instances).toHaveLength(
      _RECONNECT_DELAYS_MS_FOR_TESTING.length + 1,
    );

    // The 6th close exhausts the budget — no further reconnect scheduled.
    const last = FakeWs.instances[FakeWs.instances.length - 1]!;
    last.serverClose();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(
      _RECONNECT_DELAYS_MS_FOR_TESTING.length + 1,
    );
    expect(sessionRuntime.get('s1')!.status).toBe('disconnected');
  });

  it('EXIT frame finalizes the session — no reconnect, scrollback retained', () => {
    vi.useFakeTimers();
    sessionRuntime.attach('s1', 'tok');
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

    // EXIT closed the socket via WsClient.close(); even after the close
    // event fires, no reconnect should be scheduled.
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(1);

    const entry = sessionRuntime.get('s1')!;
    expect(entry.status).toBe('exited');
    // Scrollback survives EXIT so the user can still see history.
    expect(entry.scrollbackBytes).toBe(7);
  });

  it('scrollback respects the 4 MiB soft cap by evicting oldest chunks', () => {
    sessionRuntime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();

    // Push 6 chunks of 1 MiB each. With a 4 MiB cap we should retain at
    // most ~4 MiB; the first 2 chunks must have been evicted.
    const ONE_MIB = 1024 * 1024;
    const big = new Uint8Array(ONE_MIB);
    big.fill(0x41); // 'A'
    for (let i = 1; i <= 6; i += 1) {
      ws.receive(
        encodeFrame({ type: FrameType.OUTPUT, seq: i, payload: big }),
      );
    }
    const entry = sessionRuntime.get('s1')!;
    expect(entry.scrollbackBytes).toBeLessThanOrEqual(
      _SCROLLBACK_CAP_BYTES_FOR_TESTING,
    );
    // Should still hold AT LEAST the most recent chunk (cap is a soft target,
    // we never drop the only remaining chunk).
    expect(entry.scrollback.length).toBeGreaterThanOrEqual(1);
    // And we should have dropped strictly more than one chunk (6 pushed,
    // cap = 4 MiB = 4 chunks).
    expect(entry.scrollback.length).toBeLessThanOrEqual(4);
  });

  it('runtime publishes per-sid status into the zustand store', () => {
    sessionRuntime.attach('s1', 'tok');
    expect(useStore.getState().sessionStatuses['s1']).toBe('connecting');
    FakeWs.instances[0]!.open();
    expect(useStore.getState().sessionStatuses['s1']).toBe('attached');
  });

  // ---- T11 #654 — backpressure (PAUSE/RESUME edge-triggered) -------------
  //
  // The runtime's `notePendingWrite` / `noteWriteFlushed` model the renderer
  // queueing chunks into xterm. We never run a real Terminal here — these
  // tests poke the runtime directly and assert that PAUSE/RESUME frames hit
  // the wire at exactly the state-edge transitions, not at every tick.

  it('PAUSE frame is sent when pending writes cross the threshold', () => {
    sessionRuntime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    // Drain anything written during open (none today, but defensive).
    ws.sent.length = 0;

    // Bump pendingWrites up to (threshold - 1): no PAUSE yet.
    for (let i = 0; i < _PAUSE_THRESHOLD_FOR_TESTING - 1; i += 1) {
      sessionRuntime.notePendingWrite('s1');
    }
    expect(ws.sent).toHaveLength(0);
    expect(sessionRuntime.get('s1')!.paused).toBe(false);

    // Crossing the threshold sends exactly one PAUSE frame.
    sessionRuntime.notePendingWrite('s1');
    expect(ws.sent).toHaveLength(1);
    const decoded = decodeFrame(ws.sent[0]!);
    expect(decoded.type).toBe(FrameType.PAUSE);
    expect(decoded.payload.byteLength).toBe(0);
    expect(sessionRuntime.get('s1')!.paused).toBe(true);
  });

  it('RESUME frame is sent when the in-flight queue drains back to zero', () => {
    sessionRuntime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.sent.length = 0;

    // Push past threshold to enter paused state.
    for (let i = 0; i < _PAUSE_THRESHOLD_FOR_TESTING; i += 1) {
      sessionRuntime.notePendingWrite('s1');
    }
    expect(sessionRuntime.get('s1')!.paused).toBe(true);
    expect(ws.sent).toHaveLength(1);
    expect(decodeFrame(ws.sent[0]!).type).toBe(FrameType.PAUSE);

    // Drain N-1 writes: still paused, no RESUME yet.
    for (let i = 0; i < _PAUSE_THRESHOLD_FOR_TESTING - 1; i += 1) {
      sessionRuntime.noteWriteFlushed('s1');
    }
    expect(ws.sent).toHaveLength(1);
    expect(sessionRuntime.get('s1')!.paused).toBe(true);

    // The last drain (queue back to 0) emits exactly one RESUME.
    sessionRuntime.noteWriteFlushed('s1');
    expect(ws.sent).toHaveLength(2);
    expect(decodeFrame(ws.sent[1]!).type).toBe(FrameType.RESUME);
    expect(sessionRuntime.get('s1')!.paused).toBe(false);
    expect(sessionRuntime.get('s1')!.pendingWrites).toBe(0);
  });

  it('repeated note* calls past the threshold do not spam PAUSE frames', () => {
    // Edge-trigger property: while we are already paused, additional pending
    // writes must not emit more PAUSE frames; while we're already resumed,
    // additional flushed callbacks must not emit RESUME. This is what keeps
    // a bursty PTY from drowning the daemon in control frames.
    sessionRuntime.attach('s1', 'tok');
    const ws = FakeWs.instances[0]!;
    ws.open();
    ws.sent.length = 0;

    // Enter paused state once.
    for (let i = 0; i < _PAUSE_THRESHOLD_FOR_TESTING; i += 1) {
      sessionRuntime.notePendingWrite('s1');
    }
    expect(ws.sent).toHaveLength(1);

    // Pile on a lot more pending writes — still exactly one PAUSE total.
    for (let i = 0; i < 50; i += 1) {
      sessionRuntime.notePendingWrite('s1');
    }
    expect(ws.sent).toHaveLength(1);
    expect(decodeFrame(ws.sent[0]!).type).toBe(FrameType.PAUSE);

    // Drain everything: exactly one RESUME.
    const total = sessionRuntime.get('s1')!.pendingWrites;
    for (let i = 0; i < total; i += 1) {
      sessionRuntime.noteWriteFlushed('s1');
    }
    expect(ws.sent).toHaveLength(2);
    expect(decodeFrame(ws.sent[1]!).type).toBe(FrameType.RESUME);

    // Extra noteWriteFlushed calls (defensive: should never happen in
    // practice, but the guard exists) must not emit a second RESUME or
    // drive pendingWrites negative.
    sessionRuntime.noteWriteFlushed('s1');
    sessionRuntime.noteWriteFlushed('s1');
    expect(ws.sent).toHaveLength(2);
    expect(sessionRuntime.get('s1')!.pendingWrites).toBe(0);
  });
});
