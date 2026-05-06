// Per-session runtime: WebSocket lifecycle + scrollback + auto-reconnect.
// Task #662 / T10 (DESIGN.md §3 ring buffer mirror, §7 切 session 行为, §F6 重连).
//
// WHY THIS MODULE EXISTS:
//   T9 kept exactly one ws alive (the active session's). Switching sids tore
//   the ws down, so scrollback was lost on every switch. T10 mandates per-
//   session scrollback that survives switching, plus auto-reconnect with
//   `lastSeq` so a daemon-side ring-buffer replay (T8 #661) can fill in the
//   gap created by network blips.
//
//   The natural home for this state is NOT the zustand store: scrollback is a
//   high-frequency `Uint8Array[]` and pushing it through React would force a
//   re-render on every PTY OUTPUT frame. Instead we keep the byte-level
//   plumbing in a plain singleton module and expose a tiny pub/sub for the
//   one component that cares about live bytes (MainPane, which writes them
//   into xterm only when the sid is active).
//
//   The zustand store keeps `SessionInfo` rows + `activeSid` (the things the
//   sidebar renders) and a per-sid `status` map (so the UI can display
//   "connecting" / "disconnected"); it does NOT hold scrollback.
//
// SCROLLBACK CAP:
//   DESIGN.md §3 sets the daemon-side ring at 4 MiB. We mirror that here so a
//   reconnect that asks for the full window can succeed without the frontend
//   silently throwing data away earlier than the daemon would. Eviction is
//   FIFO at the *chunk* granularity (drop the oldest Uint8Array entries until
//   the total byte count is back under the cap).
//
// RECONNECT POLICY (T10 dispatch spec):
//   - onclose without EXIT or explicit detach => schedule reconnect.
//   - Backoff: 1s, 2s, 4s, 8s, 16s. After 5 failures we surface 'disconnected'
//     and stop trying — the user can close & re-create the session.
//   - On reconnect we pass `?lastSeq=<currentLastSeq>` so the daemon's T8
//     replay path either backfills via OUTPUT frames or sends RESET (which
//     wipes our scrollback).
//   - lastSeq update rule (carried over from T8 reviewer note):
//       newLastSeq = max(oldLastSeq, frame.seq)
//     The daemon emits chunked replay frames all bearing the *current*
//     outputSeq (not per-byte seqs), so `max` is the right merge — it never
//     regresses, and live frames after replay still bump it monotonically.

import { WsClient, type WsStatus } from './ws/client';
import { useStore } from './store';

const SCROLLBACK_CAP_BYTES = 4 * 1024 * 1024;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

export interface SessionRuntimeEntry {
  sid: string;
  client: WsClient | null;
  status: WsStatus;
  /**
   * Append-only byte chunks. We keep references to the original Uint8Array
   * payloads handed by WsClient (which already copies from the wire buffer).
   * Replay walks this array in order; eviction shifts from the front.
   */
  scrollback: Uint8Array[];
  scrollbackBytes: number;
  /**
   * Highest OUTPUT/RESET seq we have seen on the wire. Used to reconnect via
   * `?lastSeq=<n>` so daemon T8 can replay or RESET. Updated as
   * `max(prev, frame.seq)` — never regresses.
   */
  lastSeq: number;
  /**
   * Number of consecutive failed reconnect attempts. Reset to 0 on a clean
   * onopen. When the array is exhausted (>= RECONNECT_DELAYS_MS.length) we
   * stop trying and leave status='disconnected' for the UI to surface.
   */
  reconnectAttempts: number;
  /** Active retry timer, cleared on detach / successful open. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * When true, an EXIT frame or explicit detach has finalized the session.
   * Suppresses reconnect attempts that the ws.onclose handler would otherwise
   * schedule (we lean on ws.onclose for both teardown branches).
   */
  finalized: boolean;
}

/**
 * Live OUTPUT listener — called with (sid, payload) for every OUTPUT byte
 * chunk after we've appended it to scrollback. MainPane registers one of
 * these to write the bytes into xterm only when sid === activeSid.
 *
 * RESET fires `payload = null` to let the listener clear xterm.
 */
export type OutputListener = (
  sid: string,
  payload: Uint8Array | null,
) => void;

/**
 * Optional knobs (tests override the WebSocket impl + the timer/scheduler).
 * `Date.now` and `setTimeout` are NOT injected; we let vitest's fake-timers
 * handle scheduling, which keeps the module's surface small.
 */
export interface SessionRuntimeOptions {
  WebSocketImpl?: typeof WebSocket;
}

class SessionRuntime {
  private readonly entries = new Map<string, SessionRuntimeEntry>();
  private readonly outputListeners = new Set<OutputListener>();
  private opts: SessionRuntimeOptions = {};

  configure(opts: SessionRuntimeOptions): void {
    this.opts = opts;
  }

  /** Test/teardown hook: drop everything, close every ws, clear timers. */
  reset(): void {
    for (const sid of Array.from(this.entries.keys())) {
      this.detach(sid);
    }
    this.outputListeners.clear();
    this.opts = {};
  }

  has(sid: string): boolean {
    return this.entries.has(sid);
  }

  get(sid: string): SessionRuntimeEntry | undefined {
    return this.entries.get(sid);
  }

  /**
   * Begin (or no-op) tracking a session: open a ws + start receiving OUTPUT.
   * Idempotent — repeated calls for the same sid return the existing entry.
   * Caller is responsible for having a token in the store / sessionStorage.
   */
  attach(sid: string, token: string): SessionRuntimeEntry {
    const existing = this.entries.get(sid);
    if (existing) return existing;

    const entry: SessionRuntimeEntry = {
      sid,
      client: null,
      status: 'idle',
      scrollback: [],
      scrollbackBytes: 0,
      lastSeq: 0,
      reconnectAttempts: 0,
      reconnectTimer: null,
      finalized: false,
    };
    this.entries.set(sid, entry);
    this.openWs(entry, token);
    return entry;
  }

  /**
   * Stop tracking the session: close ws, cancel pending reconnect, drop
   * scrollback, remove from the entry map. Safe to call on unknown sids.
   */
  detach(sid: string): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    entry.finalized = true;
    if (entry.reconnectTimer !== null) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.client) {
      try {
        entry.client.close();
      } catch {
        // best-effort
      }
      entry.client = null;
    }
    entry.scrollback = [];
    entry.scrollbackBytes = 0;
    this.entries.delete(sid);
  }

  /** Send INPUT to the session's ws (no-op if not attached / not OPEN). */
  sendInput(sid: string, data: string): void {
    this.entries.get(sid)?.client?.sendInput(data);
  }

  /** Send RESIZE to the session's ws. */
  sendResize(sid: string, cols: number, rows: number): void {
    this.entries.get(sid)?.client?.sendResize(cols, rows);
  }

  /** Subscribe to live OUTPUT/RESET notifications. Returns unsubscribe fn. */
  subscribeOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  // ---- internals -------------------------------------------------------

  private openWs(entry: SessionRuntimeEntry, token: string): void {
    const Ctor = this.opts.WebSocketImpl;
    const client = new WsClient({
      sid: entry.sid,
      token,
      lastSeq: entry.lastSeq,
      ...(Ctor ? { WebSocketImpl: Ctor } : {}),
      onOutput: (data, seq) => this.handleOutput(entry, data, seq),
      onReset: (seq) => this.handleReset(entry, seq),
      onExit: () => this.handleExit(entry),
      onStatusChange: (status) => this.handleStatusChange(entry, status),
      onDisconnect: () => this.handleDisconnect(entry, token),
    });
    entry.client = client;
    entry.status = 'connecting';
    this.publishStatus(entry);
    client.connect();
  }

  private handleOutput(
    entry: SessionRuntimeEntry,
    payload: Uint8Array,
    seq: number,
  ): void {
    // Reconnect-attempt counter resets the moment we see real bytes flowing —
    // that's a stronger "we're alive" signal than the bare WebSocket open.
    entry.reconnectAttempts = 0;
    if (seq > entry.lastSeq) entry.lastSeq = seq;
    this.appendScrollback(entry, payload);
    for (const l of this.outputListeners) l(entry.sid, payload);
  }

  private handleReset(entry: SessionRuntimeEntry, seq: number): void {
    if (seq > entry.lastSeq) entry.lastSeq = seq;
    entry.scrollback = [];
    entry.scrollbackBytes = 0;
    for (const l of this.outputListeners) l(entry.sid, null);
  }

  private handleExit(entry: SessionRuntimeEntry): void {
    // EXIT means the daemon-side PTY is gone; never reconnect. We DO leave
    // scrollback intact so the user can still scroll back through history
    // after the session ends. Cleanup happens via detach() (e.g. when the
    // user closes the row from the sidebar).
    entry.finalized = true;
    if (entry.reconnectTimer !== null) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    entry.status = 'exited';
    this.publishStatus(entry);
  }

  private handleStatusChange(
    entry: SessionRuntimeEntry,
    status: WsStatus,
  ): void {
    // Don't let WsClient stomp 'exited' (handleExit already set it) or our
    // 'disconnected' marker after the reconnect budget is spent.
    if (entry.finalized && status !== 'exited') return;
    entry.status = status;
    if (status === 'attached') {
      entry.reconnectAttempts = 0;
    }
    this.publishStatus(entry);
  }

  private handleDisconnect(entry: SessionRuntimeEntry, token: string): void {
    if (entry.finalized) return;
    if (entry.client) {
      // The closed WsClient is dead from here on; let GC reclaim it.
      entry.client = null;
    }
    if (entry.reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
      // Budget exhausted — leave status='disconnected' for the UI to surface.
      entry.status = 'disconnected';
      this.publishStatus(entry);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[entry.reconnectAttempts]!;
    entry.reconnectAttempts += 1;
    entry.status = 'connecting';
    this.publishStatus(entry);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      // Re-check: a detach() between schedule and fire MUST suppress us.
      if (entry.finalized) return;
      this.openWs(entry, token);
    }, delay);
  }

  private appendScrollback(
    entry: SessionRuntimeEntry,
    payload: Uint8Array,
  ): void {
    if (payload.byteLength === 0) return;
    entry.scrollback.push(payload);
    entry.scrollbackBytes += payload.byteLength;
    while (
      entry.scrollbackBytes > SCROLLBACK_CAP_BYTES &&
      entry.scrollback.length > 1
    ) {
      const dropped = entry.scrollback.shift();
      if (!dropped) break;
      entry.scrollbackBytes -= dropped.byteLength;
    }
  }

  private publishStatus(entry: SessionRuntimeEntry): void {
    // Fan status into zustand so UI components (sidebar status dot, future
    // toolbar) can subscribe through the normal store hook. Keeping this in
    // a single place avoids drift between the runtime's internal state and
    // what React renders.
    useStore.getState().setSessionStatus(entry.sid, entry.status);
  }
}

// Module-singleton. Tests call `.reset()` between cases.
export const sessionRuntime = new SessionRuntime();

// Re-exported only for unit tests that want to construct their own runtime
// in isolation. Production code should use the singleton.
export { SessionRuntime as _SessionRuntimeClassForTesting };
export const _SCROLLBACK_CAP_BYTES_FOR_TESTING = SCROLLBACK_CAP_BYTES;
export const _RECONNECT_DELAYS_MS_FOR_TESTING = RECONNECT_DELAYS_MS;
