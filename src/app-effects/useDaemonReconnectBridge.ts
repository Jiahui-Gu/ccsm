// T69 — `useDaemonReconnectBridge`: pure observer/emitter hook that
// detects (a) daemon `bootNonce` changes and (b) stream-dead events,
// republishing both as `CustomEvent`s on the global `window` event bus
// for T70 (`reconnectQueue`, Task #1029) to consume.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//     §3.5.1.4 — every daemon-emitted PTY envelope (heartbeat, delta,
//     snapshot) carries `bootNonce`; the client tracks the last-seen
//     value and presents `fromBootNonce` on resubscribe. A change in
//     observed nonce means the daemon was restarted and any in-flight
//     replay state is invalid.
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.5.1 — server-side stream-dead detector closes the stream with
//     `RESOURCE_EXHAUSTED, reason: 'server-stream-dead'`. The renderer
//     observes this as a stream termination event from T44 and must
//     trigger reconnect-replay (owned by T70).
//   - docs/superpowers/specs/v0.3-design.md §3.7.4 — reconnect bridge
//     is a renderer concern; the 250 ms hold-off and surface-registry
//     publish belong to T70 (queue + reconnect mechanics). This hook
//     does NOT own queueing, hold-off, or surface publishing — only
//     OBSERVATION + EMISSION.
//
// Single Responsibility (per `feedback_single_responsibility`):
//   PRODUCER. Watches a daemon-event source for `bootNonce`/stream-dead
//   signals; emits two well-known `CustomEvent`s. Owns no I/O, no
//   queueing, no reconnect logic. T70 (#1029) owns the SINK.
//
// Note on file location: task brief asked for `src/hooks/`; codebase
// convention is `src/app-effects/` for renderer-side IPC/event bridge
// hooks (see neighbouring `usePtyExitBridge.ts`, `useAgentEventBridge.ts`,
// `usePersistErrorBridge.ts`). Following codebase convention per Layer 1
// reviewer discipline.
//
// Note on T48 wiring: the daemon-side stamper (`from-boot-nonce-stamper.ts`,
// PR #695) is built but NOT yet wired through the IPC bridge. This hook
// accepts a `subscribe` function so the future wiring (a follow-up that
// adds `window.ccsmPty.onDaemonHealth` or extends `pty:data` payloads
// with `bootNonce`) can inject the source without changing the hook's
// surface. Until then, callers can pass a no-op `() => () => {}` and
// the hook is a clean no-op.
//
// Note on event-bus contract (coordinate with T70 #1029): we use
// `window.dispatchEvent(new CustomEvent(name, { detail }))` with two
// channel names:
//   - 'ccsm:daemon-bootChanged' — detail: { previousNonce, newNonce }
//   - 'ccsm:daemon-streamDead'  — detail: { sid, reason }
// T70 subscribes via `window.addEventListener(name, handler)`. Pure
// renderer-side bus; no preload/IPC required (these are observations of
// already-arrived IPC, not new IPC channels). If T70 lands first with a
// different bus shape (EventEmitter in `src/lib/daemon-events.ts`), this
// hook should be re-pointed; the contract is intentionally small.

import { useEffect, useRef } from 'react';

/**
 * Snapshot of an inbound daemon event observed by the bridge. The hook
 * does NOT care which transport carried it (PTY data envelope, future
 * `daemonHealth` IPC, etc.); the wiring layer normalizes into this
 * shape.
 *
 * - `bootNonce` is set on every daemon-originated frame once T48 is
 *   wired through. Until then this field will simply never appear and
 *   the hook stays silent.
 * - `streamDead` is set when the renderer observes a stream
 *   termination from the server-side detector (frag-6-7 §6.5.1). The
 *   wiring layer maps the underlying RESOURCE_EXHAUSTED close into
 *   `{ streamDead: { sid, reason } }`.
 */
export interface DaemonHealthSignal {
  readonly bootNonce?: string;
  readonly streamDead?: { readonly sid: string; readonly reason: string };
}

/**
 * Subscriber contract: callers pass a function that registers `cb` as
 * an observer of daemon health signals and returns an unsubscribe fn.
 * Mirrors the shape of `window.ccsmPty.onExit` etc. (set-based fan-out
 * already used by other bridges; trivial to back with a `Set` in the
 * preload bridge once wiring lands).
 */
export type DaemonHealthSubscribe = (
  cb: (signal: DaemonHealthSignal) => void,
) => () => void;

/**
 * Public event names on the renderer-side bus. Consumed by T70
 * (`reconnectQueue`, Task #1029). Kept as named constants so a typo on
 * either side is a TypeScript error rather than a silent miss.
 */
export const DAEMON_BOOT_CHANGED_EVENT = 'ccsm:daemon-bootChanged';
export const DAEMON_STREAM_DEAD_EVENT = 'ccsm:daemon-streamDead';

export interface BootChangedDetail {
  /** The nonce we had before the change. `null` on the very first
   * detection (we had nothing, then saw something — not a "change"
   * proper, so the hook intentionally does NOT emit in that case; the
   * field exists only on second-and-later transitions, where it is
   * always a string). */
  readonly previousNonce: string;
  readonly newNonce: string;
}

export interface StreamDeadDetail {
  readonly sid: string;
  readonly reason: string;
}

/**
 * Pure observer hook. Tracks the most recently observed `bootNonce`
 * across renders (via `useRef` so re-renders don't reset state) and
 * emits a `bootChanged` CustomEvent on the FIRST signal that carries a
 * different nonce. The very first signal that carries a nonce is
 * recorded silently (there's no "previous" to compare to — the daemon
 * just told us its identity).
 *
 * Stream-dead signals are forwarded 1:1; no de-dup (T70 owns idempotent
 * reconnect logic — duplicate emissions are tolerated by design).
 *
 * The hook returns nothing; consumers wire it into App.tsx alongside
 * the other `app-effects/use*Bridge` hooks.
 */
export function useDaemonReconnectBridge(
  subscribe: DaemonHealthSubscribe | null | undefined,
): void {
  // Persists across renders without triggering re-render on update.
  // `null` until the first nonce-carrying signal arrives.
  const lastSeenNonce = useRef<string | null>(null);

  useEffect(() => {
    if (!subscribe) return;
    const unsubscribe = subscribe((signal) => {
      // bootChanged detection: compare against last-seen.
      if (signal.bootNonce !== undefined && signal.bootNonce.length > 0) {
        const previous = lastSeenNonce.current;
        if (previous !== null && previous !== signal.bootNonce) {
          // Real change — daemon was restarted between observations.
          const detail: BootChangedDetail = {
            previousNonce: previous,
            newNonce: signal.bootNonce,
          };
          window.dispatchEvent(
            new CustomEvent<BootChangedDetail>(DAEMON_BOOT_CHANGED_EVENT, {
              detail,
            }),
          );
        }
        // Always record the latest (whether first observation or a
        // post-change update). After dispatching, advance our cursor
        // so a subsequent identical nonce is a no-op.
        lastSeenNonce.current = signal.bootNonce;
      }

      // streamDead: pure forward. Multiple sids can die in quick
      // succession (one daemon stream-close cascades to all dependent
      // streams per frag-6-7 §6.5.1); we emit one event per signal and
      // let T70 dedupe / aggregate.
      if (signal.streamDead) {
        const detail: StreamDeadDetail = {
          sid: signal.streamDead.sid,
          reason: signal.streamDead.reason,
        };
        window.dispatchEvent(
          new CustomEvent<StreamDeadDetail>(DAEMON_STREAM_DEAD_EVENT, {
            detail,
          }),
        );
      }
    });
    return unsubscribe;
  }, [subscribe]);
}
