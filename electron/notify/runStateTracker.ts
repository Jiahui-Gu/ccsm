// Per-sid run-state tracker for the notify pipeline.
//
// Owns the idle-confirmation window: an OSC `idle`/`waiting` title does NOT
// notify immediately. Instead it starts an IDLE_CONFIRM_MS timer. If a
// `running` title arrives before the timer elapses, the idle was a mid-task
// pause (the CLI resumes itself) and is dropped. If the timer elapses while
// still idle, it is a real stop — we run the pure decider once and emit a
// single confirmed-idle decision through `onConfirmedIdle`.
//
// This window is the entire mid-task-pause filter. A real stop (Claude asks
// a question / the task is complete) is NOT followed by `running` until the
// user acts, so it survives the window; a transient `✳` pause is always
// followed by `running`, so it never does.
//
// Pure-ish: no Electron, no I/O. Depends only on the injected `decide()` and
// injectable timer/clock fns so tests can drive it deterministically.

import { type Ctx, type Decision, type Event } from './notifyDecider';

export type TitleClassification = 'idle' | 'running' | 'waiting' | 'unknown';

/**
 * Idle confirmation window. After an `idle` title, wait this long before
 * treating the stop as real. Each fresh idle resets it; any `running`
 * cancels it. 1500ms is the starting value (tunable in a follow-up):
 *   - too short → slow-tool gaps between steps read as a real stop
 *   - too long  → the user waits this long after a genuine stop
 */
export const IDLE_CONFIRM_MS = 1_500;

export interface RunStateTrackerOptions {
  /** Override the confirmation window (test only). Defaults to IDLE_CONFIRM_MS. */
  idleConfirmMs?: number;
  /** Wall-clock provider. Defaults to Date.now. */
  nowFn?: () => number;
  /** setTimeout / clearTimeout overrides. Default to globalThis. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Called once when an idle survives the confirmation window. Receives the
   *  decider's Decision (toast/flash per the focus/active/mute matrix). */
  onConfirmedIdle?: (decision: Decision) => void;
}

export interface RunStateTracker {
  /** Producer entry — feed a classified title for `sid` at `nowTs`. Always
   *  returns null; decisions are emitted asynchronously via onConfirmedIdle
   *  when the window closes. */
  onTitle(sid: string, classification: TitleClassification, nowTs: number): Decision | null;
  /** Drop all per-sid state for `sid` (session teardown). Cancels its window. */
  forgetSid(sid: string): void;
  setFocused(focused: boolean): void;
  setActiveSid(sid: string | null): void;
  markUserInput(sid: string, nowTs: number): void;
  /** Mute `sid` until `untilTs` (use `Infinity` for sticky). Pass `null` to clear. */
  setMuted(sid: string, untilTs: number | null): void;
  /** Cancel all pending idle-confirm timers (test / shutdown cleanup). */
  dispose(): void;
  /** Test-only — read internal maps for assertion. */
  _internals(): {
    runStartTs: Map<string, number>;
    mutedSids: Map<string, number>;
    lastFiredTs: Map<string, number>;
    lastUserInputTs: Map<string, number>;
    focused: boolean;
    activeSid: string | null;
    /** sids with an outstanding idle-confirm timer. */
    pendingIdleSids: string[];
  };
}

export function createRunStateTracker(
  decide: (event: Event, ctx: Ctx) => Decision | null,
  options: RunStateTrackerOptions = {},
): RunStateTracker {
  const idleConfirmMs = options.idleConfirmMs ?? IDLE_CONFIRM_MS;
  const nowFn = options.nowFn ?? Date.now;
  const setTimeoutFn =
    options.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const onConfirmedIdle = options.onConfirmedIdle;

  const runStartTs = new Map<string, number>();
  /** Map<sid, untilTs> — entry present + nowTs < untilTs ⇒ sid is muted. */
  const mutedSids = new Map<string, number>();
  const lastFiredTs = new Map<string, number>();
  const lastUserInputTs = new Map<string, number>();
  /** Per-sid outstanding idle-confirm timer handle. Cancelled on `running`,
   *  forgetSid, and dispose. Reset on each fresh idle. */
  const pendingIdleTimers = new Map<string, unknown>();
  /** Per-sid gate (#767): true once we've seen a `running` title for this sid
   *  in the current process. The CLI boot banner emits an `idle` title with
   *  no prior `running`; without this gate that would start a window and fire
   *  a phantom notification on every fresh/imported/resumed session. */
  const hasObservedRunning = new Set<string>();
  let focused = true;
  let activeSid: string | null = null;

  function activeMutedSet(nowTs: number): Set<string> {
    const out = new Set<string>();
    for (const [sid, until] of mutedSids) {
      if (nowTs < until) out.add(sid);
    }
    return out;
  }

  function cancelIdleTimer(sid: string): void {
    const t = pendingIdleTimers.get(sid);
    if (t !== undefined) {
      clearTimeoutFn(t);
      pendingIdleTimers.delete(sid);
    }
  }

  /** Start (or reset) the idle-confirmation window for `sid`. On elapse, run
   *  the decider once against a snapshot taken AT FIRE TIME and, if it returns
   *  a decision, emit it through onConfirmedIdle. */
  function startIdleTimer(sid: string): void {
    cancelIdleTimer(sid);
    const handle = setTimeoutFn(() => {
      pendingIdleTimers.delete(sid);
      const fireTs = nowFn();
      const ctx: Ctx = {
        focused,
        activeSid,
        lastUserInputTs,
        runStartTs,
        mutedSids: activeMutedSet(fireTs),
        lastFiredTs,
        now: fireTs,
      };
      const event: Event = { type: 'osc-title', sid, title: 'idle', ts: fireTs };
      const decision = decide(event, ctx);
      // The run is over — clear its start clock regardless of outcome.
      runStartTs.delete(sid);
      if (decision !== null) {
        lastFiredTs.set(sid, fireTs);
        onConfirmedIdle?.(decision);
      }
    }, idleConfirmMs);
    pendingIdleTimers.set(sid, handle);
  }

  return {
    onTitle(sid, classification, nowTs) {
      if (classification === 'unknown') return null;

      if (classification === 'running') {
        if (!runStartTs.has(sid)) runStartTs.set(sid, nowTs);
        hasObservedRunning.add(sid);
        // A pending idle was a mid-task pause — the CLI resumed. Drop it.
        cancelIdleTimer(sid);
        return null;
      }

      // 'idle' or 'waiting'.
      // Boot gate (#767): no real task to notify on until we've seen running.
      if (!hasObservedRunning.has(sid)) {
        runStartTs.delete(sid);
        return null;
      }

      // Start/reset the confirmation window. No synchronous decision.
      startIdleTimer(sid);
      return null;
    },
    forgetSid(sid) {
      runStartTs.delete(sid);
      mutedSids.delete(sid);
      lastFiredTs.delete(sid);
      lastUserInputTs.delete(sid);
      hasObservedRunning.delete(sid);
      cancelIdleTimer(sid);
    },
    setFocused(next) {
      focused = next;
    },
    setActiveSid(sid) {
      activeSid = sid;
    },
    markUserInput(sid, nowTs) {
      lastUserInputTs.set(sid, nowTs);
    },
    setMuted(sid, untilTs) {
      if (untilTs === null) mutedSids.delete(sid);
      else mutedSids.set(sid, untilTs);
    },
    dispose() {
      for (const handle of pendingIdleTimers.values()) clearTimeoutFn(handle);
      pendingIdleTimers.clear();
    },
    _internals() {
      return {
        runStartTs,
        mutedSids,
        lastFiredTs,
        lastUserInputTs,
        focused,
        activeSid,
        pendingIdleSids: Array.from(pendingIdleTimers.keys()),
      };
    },
  };
}
