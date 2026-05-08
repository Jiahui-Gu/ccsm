// @ccsm/core runtime — public types (wave-2 T5).
//
// Split out from session-runtime.ts so adapters (frontend-web, frontend-tauri)
// can `import type { SessionRuntimeEntry, WsStatus } from '@ccsm/core/runtime/types'`
// without dragging the runtime class onto the type-resolution graph.

import type { WsClient, WsStatus } from '../ws/client.js';

export type { WsStatus };

/**
 * Daemon-side ring buffer cap (DESIGN.md §3 — 4 MiB). We mirror it here so
 * scrollback eviction tracks what the daemon would replay on reconnect.
 */
export const SCROLLBACK_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Reconnect backoff schedule. After this many failures we surface
 * `disconnected` and stop trying. Length === retry budget.
 */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/**
 * T11 #654 — backpressure threshold. When `pendingWrites` (outstanding xterm
 * `term.write` callbacks) crosses this upward we send PAUSE; back to 0 we
 * send RESUME. Edge-triggered. See session-runtime.ts for rationale.
 */
export const PAUSE_THRESHOLD = 16;

export interface SessionRuntimeEntry {
  sid: string;
  client: WsClient | null;
  status: WsStatus;
  /**
   * Append-only byte chunks. We hold references to the original Uint8Array
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
  /**
   * True once we have ever observed status='attached' for this entry — i.e.
   * the ws has actually established at least once. Differs from
   * `reconnectAttempts === 0`: that becomes 1 the moment ws.onclose fires
   * (synchronously, before the retry timer), so by the time a click handler
   * inspects it the value can already be > 0 even though the user perceives
   * the entry as "still freshly attached, never confirmed alive".
   *
   * Used by Sidebar onSelectSession to decide whether a `connecting` status
   * is freshly-spawned (skip /resume, fast-path setActive) or genuinely
   * stale across a daemon restart (slow-path resume + detach + re-attach).
   *
   * Once set true, NEVER reset — even after a reconnect cycle, because
   * "ever attached at least once in this entry's lifetime" is exactly what
   * distinguishes "the daemon spawned a PTY and we talked to it" from "the
   * daemon never spawned a PTY for this sid in this process". This is the
   * #673 fix invariant; tests pin it.
   */
  hasEverAttached: boolean;
  /** Active retry timer, cleared on detach / successful open. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /**
   * When true, an EXIT frame or explicit detach has finalized the session.
   * Suppresses reconnect attempts that the ws.onclose handler would otherwise
   * schedule (we lean on ws.onclose for both teardown branches).
   */
  finalized: boolean;
  /**
   * T11 #654: count of `term.write(...)` calls whose flush callback hasn't
   * fired yet. Bumped by `notePendingWrite()` (called by the renderer right
   * before each xterm.write of an OUTPUT chunk for the active sid) and
   * decremented by `noteWriteFlushed()` from xterm's flush callback.
   */
  pendingWrites: number;
  /**
   * T11 #654: edge-trigger flag for PAUSE/RESUME. We only send a control
   * frame when this changes; otherwise a chatty PTY would spam frames.
   */
  paused: boolean;
  /**
   * Task #61 (R-21) — INPUT frames received via `sendInput` before the ws
   * has reached OPEN. Without this queue, keystrokes typed during the
   * createSession→ws-attached window (~340ms in cloud-mode smoke) hit
   * `WsClient.sendInput`, see `readyState !== OPEN`, and are silently
   * dropped. We push them here in arrival order and flush them on the
   * `attached` status edge in `session-runtime.ts`.
   *
   * No coalescing — each user keystroke is a distinct INPUT chunk. The
   * queue is unbounded by design (token boot only ever buffers a handful
   * of keystrokes; an attached ws drains it instantly).
   */
  pendingInput: string[];
}

/**
 * Live OUTPUT listener — called with (sid, payload, seq) for every OUTPUT
 * byte chunk after we've appended it to scrollback. The renderer registers
 * one of these to write the bytes into xterm only when sid === activeSid.
 *
 * RESET fires `payload = null` to let the listener clear xterm; `seq` is
 * the new baseline.
 */
export type OutputListener = (
  sid: string,
  payload: Uint8Array | null,
  seq: number,
) => void;

/**
 * Status sink — invoked synchronously every time a session's `WsStatus`
 * changes (initial connect, attached, disconnect, reconnect, exit, etc.).
 *
 * The frontend-web adapter wires this to `useStore.getState().setSessionStatus`
 * so React re-renders the sidebar dot. Tauri can wire it to whatever state
 * shape it prefers. Runtime itself never touches React/zustand.
 *
 * Contract: must be synchronous (called inline from ws event handlers),
 * non-throwing, idempotent on duplicate values.
 */
export type StatusSink = (sid: string, status: WsStatus) => void;

/**
 * Output sink — optional firehose for OUTPUT/RESET frames. Same payload
 * convention as `OutputListener` (payload=null for RESET). Different from
 * `subscribeOutput` in that this is a single injected sink resolved at
 * construction (suitable for an adapter funnel) — the pub/sub
 * `subscribeOutput` API stays for renderer components that come and go.
 */
export type OutputSink = OutputListener;
