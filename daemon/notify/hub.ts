/**
 * In-process notify event bus (Wave-2-C).
 *
 * The daemon's notify subsystem produces a stream of `Decision`s (when an OSC
 * waiting transition fires AND survives the 7-rule decider + dedupe). The
 * SSE endpoint at `/api/events/notify` (daemon/api/events.ts) subscribes to
 * this bus and serializes each Decision as an SSE `data:` frame back to the
 * electron renderer; the electron sink consumer (toast/flash) then runs the
 * OS effects on the daemon's behalf.
 *
 * The bus also fronts the producer surface so other daemon modules — the
 * eventual W2-B PTY-in-daemon mv, or the interim electron-side OSC sniffer
 * bridge POSTing through `/api/notify/feedOsc` — can call `feedOsc(sid,
 * title, ts)` without each one re-creating the runStateTracker.
 *
 * SRP: hub is wiring + fan-out. The decider (notifyDecider.decide) and
 * tracker (createRunStateTracker) stay pure modules; hub holds the singleton
 * tracker instance and the listener set, nothing else.
 */

import { createRunStateTracker, type RunStateTracker } from "./runStateTracker";
import { decide, type Decision } from "./notifyDecider";
import { classifyTitleState } from "./titleStateClassifier";

export type DecisionListener = (d: Decision) => void;

export interface NotifyHub {
  /** Producer entry — a raw OSC title for `sid` at `nowTs`. Returns the
   *  decision the decider produced (if any). */
  feedOsc(sid: string, title: string, nowTs?: number): Decision | null;
  /** Per-sid lifecycle: fired when the user touches the sid (new / resume /
   *  switch). Sets a sticky mute (mirrors pipeline.markUserInput semantics). */
  markUserInput(sid: string): void;
  setActiveSid(sid: string | null): void;
  setFocused(focused: boolean): void;
  /** Set / clear per-sid mute. */
  setMuted(sid: string, muted: boolean): void;
  /** Drop all per-sid state (session teardown). */
  forgetSid(sid: string): void;
  /** Subscribe to decisions. Returns an unsubscribe. */
  onDecision(cb: DecisionListener): () => void;
  /** Test seam — read tracker internals. */
  _internals(): { tracker: RunStateTracker; listenerCount: number };
  /** Tear down listeners (test cleanup / shutdown). */
  dispose(): void;
}

function createHub(): NotifyHub {
  const tracker = createRunStateTracker(decide);
  const listeners = new Set<DecisionListener>();
  let globalMuted = false; // wave-2-C reserves the surface; settings hookup is W2-A.

  function fanOut(d: Decision): void {
    for (const cb of listeners) {
      try {
        cb(d);
      } catch (err) {
        process.stderr.write(
          `[notifyHub] listener threw: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  return {
    feedOsc(sid, title, nowTs) {
      const now = nowTs ?? Date.now();
      const cls = classifyTitleState(title);
      // Global mute short-circuit (matches electron pipeline behaviour).
      if (cls === "idle" && globalMuted) {
        tracker.forgetSid(sid);
        return null;
      }
      const decision = tracker.onTitle(sid, cls, now);
      if (decision) fanOut(decision);
      return decision;
    },
    markUserInput(sid) {
      // Sticky permanent mute — mirrors electron pipeline.markUserInput.
      tracker.setMuted(sid, Number.POSITIVE_INFINITY);
    },
    setActiveSid(sid) {
      tracker.setActiveSid(sid);
    },
    setFocused(focused) {
      tracker.setFocused(focused);
    },
    setMuted(sid, muted) {
      tracker.setMuted(sid, muted ? Number.POSITIVE_INFINITY : null);
    },
    forgetSid(sid) {
      tracker.forgetSid(sid);
    },
    onDecision(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    _internals() {
      return { tracker, listenerCount: listeners.size };
    },
    dispose() {
      listeners.clear();
    },
  };
}

/** Singleton hub for the daemon process. */
export const notifyHub: NotifyHub = createHub();

/** Test factory — fresh instance, no shared state. */
export function __createNotifyHubForTest(): NotifyHub {
  return createHub();
}
