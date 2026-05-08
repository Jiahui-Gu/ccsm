// Per-session runtime: WebSocket lifecycle + scrollback + auto-reconnect.
//
// History: Task #662 / T10 (DESIGN.md §3 ring buffer mirror, §7 session
// switch behavior, §F6 reconnect). #673 added the `hasEverAttached` invariant for sidebar
// fast-path. Wave-2 T5 (#688) lifts this module out of `packages/frontend`
// into `@ccsm/core` and decouples it from zustand: the runtime now takes
// `statusSink` (and optional `outputSink`) at construction; React-specific
// state writes happen in the adapter, not here.
//
// WHY THIS MODULE EXISTS:
//   T9 kept exactly one ws alive (the active session's). Switching sids tore
//   the ws down, so scrollback was lost on every switch. T10 mandated per-
//   session scrollback that survives switching, plus auto-reconnect with
//   `lastSeq` so a daemon-side ring-buffer replay (T8 #661) can fill in the
//   gap created by network blips.
//
//   The natural home for this state is NOT React state: scrollback is a
//   high-frequency `Uint8Array[]` and pushing it through React would force a
//   re-render on every PTY OUTPUT frame. We keep the byte-level plumbing
//   here and expose two channels:
//     1. `statusSink` — coarse `WsStatus` transitions, fires only on edges.
//        Adapters (web → zustand `setSessionStatus`, Tauri → its own store)
//        wire this into whatever React state shape they use.
//     2. `subscribeOutput` / `outputSink` — live byte chunks. The active-sid
//        renderer (MainPane) writes these into xterm; non-active sids only
//        accumulate scrollback.
//
// SCROLLBACK CAP:
//   DESIGN.md §3 sets the daemon-side ring at 4 MiB. We mirror that here so
//   a reconnect that asks for the full window can succeed without the
//   frontend silently throwing data away earlier than the daemon would.
//   Eviction is FIFO at the *chunk* granularity (drop oldest Uint8Array
//   entries until total bytes is back under the cap).
//
// RECONNECT POLICY (T10 dispatch spec):
//   - onclose without EXIT or explicit detach => schedule reconnect.
//   - Backoff: 1s, 2s, 4s, 8s, 16s. After 5 failures we surface
//     'disconnected' and stop trying — the user can close & re-create.
//   - On reconnect we pass `?lastSeq=<currentLastSeq>` so the daemon's T8
//     replay path either backfills via OUTPUT frames or sends RESET (which
//     wipes our scrollback).
//   - lastSeq update rule: newLastSeq = max(oldLastSeq, frame.seq).
//     The daemon emits chunked replay frames all bearing the *current*
//     outputSeq (not per-byte seqs), so `max` is the right merge — never
//     regresses, and live frames after replay still bump it monotonically.
//
// hasEverAttached INVARIANT (#673 fix — DO NOT BREAK):
//   Set to `true` the first time `WsStatus === 'attached'` and NEVER reset.
//   Sidebar fast-path uses this to decide between "freshly-spawned, skip
//   /resume" vs "stale across daemon restart, slow-path resume + detach".
//   `reconnectAttempts === 0` is NOT a substitute (it flips on close).

import { WsClient } from '../ws/client.js';
import type { HostBase, WsStatus } from '../ws/client.js';
import {
  PAUSE_THRESHOLD,
  RECONNECT_DELAYS_MS,
  SCROLLBACK_CAP_BYTES,
  type OutputListener,
  type OutputSink,
  type SessionRuntimeEntry,
  type StatusSink,
} from './types.js';

export type {
  OutputListener,
  OutputSink,
  SessionRuntimeEntry,
  StatusSink,
  WsStatus,
} from './types.js';
export {
  PAUSE_THRESHOLD,
  RECONNECT_DELAYS_MS,
  SCROLLBACK_CAP_BYTES,
} from './types.js';

/**
 * Construction options — what the adapter must inject so the runtime can
 * stay framework-agnostic.
 *
 * - `hostBase`: where the daemon lives (`http://127.0.0.1:<port>`). Web
 *   adapter derives this from `window.location`; Tauri from the spawn
 *   handshake. Forwarded to every WsClient this runtime constructs.
 * - `statusSink`: invoked synchronously on every `WsStatus` edge. Adapters
 *   route to React state. Required.
 * - `outputSink`: optional single-listener firehose for OUTPUT/RESET. Same
 *   payload contract as `subscribeOutput` (payload=null for RESET). Use this
 *   for a long-lived adapter funnel; use `subscribeOutput` for ephemeral
 *   component listeners.
 * - `WebSocketImpl`: tests inject `FakeWs`; production omits.
 */
export interface SessionRuntimeOptions {
  hostBase: HostBase;
  statusSink: StatusSink;
  outputSink?: OutputSink;
  WebSocketImpl?: typeof WebSocket;
}

export class SessionRuntime {
  private readonly entries = new Map<string, SessionRuntimeEntry>();
  private readonly outputListeners = new Set<OutputListener>();
  private readonly opts: SessionRuntimeOptions;

  constructor(opts: SessionRuntimeOptions) {
    this.opts = opts;
  }

  /** Test/teardown hook: drop everything, close every ws, clear timers. */
  reset(): void {
    for (const sid of Array.from(this.entries.keys())) {
      this.detach(sid);
    }
    this.outputListeners.clear();
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
   * Caller is responsible for having a live `token` (from the daemon
   * handshake on web, or the Tauri invoke on desktop).
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
      hasEverAttached: false,
      pendingWrites: 0,
      paused: false,
      pendingInput: [],
    };
    this.entries.set(sid, entry);
    this.openWs(entry, token);
    return entry;
  }

  /**
   * Stop tracking the session: close ws, cancel pending reconnect, drop
   * scrollback, remove from the entry map. Idempotent — safe to call on
   * unknown sids or twice in a row (second call is a no-op).
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

  /**
   * Send INPUT to the session's ws.
   *
   * Task #61 (R-21) — buffer-until-open: keystrokes that arrive while the
   * ws is `connecting` (or its `client` slot is briefly null between
   * close and reconnect) are queued on `entry.pendingInput`, in arrival
   * order, and flushed verbatim on the `attached` status edge. Without
   * this buffer, the ~340ms createSession→ws-OPEN window in cloud-mode
   * smoke silently drops every keystroke the user typed before xterm's
   * onData saw an open socket — research-60 confirmed 22 dropped chars on
   * a single happy-path run.
   *
   * If `sid` is unknown (no runtime entry) we drop on the floor — there's
   * nothing to attach the queue to and the caller (xterm onData) already
   * gates on `activeSidRef`. The OPEN-but-no-entry case is impossible.
   */
  sendInput(sid: string, data: string): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    const client = entry.client;
    if (client && client.getStatus() === 'attached') {
      client.sendInput(data);
      return;
    }
    entry.pendingInput.push(data);
  }

  /** Send RESIZE to the session's ws. */
  sendResize(sid: string, cols: number, rows: number): void {
    this.entries.get(sid)?.client?.sendResize(cols, rows);
  }

  /**
   * T11 #654 — backpressure: caller signals it just enqueued an xterm write.
   * If the in-flight queue depth crosses PAUSE_THRESHOLD upward, we send a
   * PAUSE frame so the daemon stops pushing OUTPUT to this subscriber. Edge-
   * triggered: only a state transition produces a control frame.
   */
  notePendingWrite(sid: string): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    entry.pendingWrites += 1;
    if (!entry.paused && entry.pendingWrites >= PAUSE_THRESHOLD) {
      entry.paused = true;
      entry.client?.sendPause();
    }
  }

  /**
   * T11 #654 — backpressure: caller (xterm flush callback) signals one write
   * has drained. When the queue empties AND we're paused, send RESUME so the
   * daemon flushes its per-subscriber backlog and resumes live forwarding.
   */
  noteWriteFlushed(sid: string): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    if (entry.pendingWrites > 0) entry.pendingWrites -= 1;
    if (entry.paused && entry.pendingWrites === 0) {
      entry.paused = false;
      entry.client?.sendResume();
    }
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
      hostBase: this.opts.hostBase,
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
    // a stronger "we're alive" signal than the bare WebSocket open.
    entry.reconnectAttempts = 0;
    if (seq > entry.lastSeq) entry.lastSeq = seq;
    this.appendScrollback(entry, payload);
    this.fanOutput(entry.sid, payload, seq);
  }

  private handleReset(entry: SessionRuntimeEntry, seq: number): void {
    if (seq > entry.lastSeq) entry.lastSeq = seq;
    entry.scrollback = [];
    entry.scrollbackBytes = 0;
    this.fanOutput(entry.sid, null, seq);
  }

  private handleExit(entry: SessionRuntimeEntry): void {
    // EXIT means the daemon-side PTY is gone; never reconnect. We DO leave
    // scrollback intact so the user can scroll back through history after
    // the session ends. Cleanup happens via detach() (e.g. when the user
    // closes the row from the sidebar).
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
      // #673 invariant: once true, never reset. See types.ts JSDoc.
      entry.hasEverAttached = true;
      // Task #61 (R-21): flush keystrokes that arrived while the ws was
      // still `connecting`. Order-preserving, no coalescing — each entry
      // is one user-visible INPUT frame.
      if (entry.pendingInput.length > 0 && entry.client) {
        const queued = entry.pendingInput;
        entry.pendingInput = [];
        for (const data of queued) {
          entry.client.sendInput(data);
        }
      }
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

  private fanOutput(
    sid: string,
    payload: Uint8Array | null,
    seq: number,
  ): void {
    // Adapter-injected sink first, then ephemeral subscribers. Order is
    // observable to consumers; we keep the sink first so adapters that want
    // to gate everything else (e.g. permissions) get first crack.
    this.opts.outputSink?.(sid, payload, seq);
    for (const l of this.outputListeners) l(sid, payload, seq);
  }

  private publishStatus(entry: SessionRuntimeEntry): void {
    // Adapter routes this into its own state shape (zustand on web, etc.).
    // Synchronous by contract — see StatusSink JSDoc in types.ts.
    this.opts.statusSink(entry.sid, entry.status);
  }
}
