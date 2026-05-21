// Pure run-state decider for the notify pipeline (Task #721 Phase A).
//
// Extracts the per-sid state-machine that lives inside `sinks/pipeline.ts`
// today (runStartTs / mutedSids / lastFiredTs and the surrounding context
// fields the decider reads) into a standalone, Electron-free module so it
// can be unit-tested in isolation and re-used by Phase B (where pipeline
// will switch over to delegate here).
//
// Design notes:
//   * Pure — no Electron, no I/O. Only depends on the existing
//     `notifyDecider.decide()` (injected so the test can stub it if it
//     wants, and so we never hard-link to the module at construction).
//   * Owns the mutable state that pipeline previously kept inline:
//       - runStartTs:    Map<sid, ms>     — when the current run began
//       - mutedSids:     Map<sid, untilTs>— per-sid mute window
//                                            (untilTs === Infinity = sticky)
//       - lastFiredTs:   Map<sid, ms>     — for the decider's 5s dedupe
//       - lastUserInputTs / focused / activeSid — context fields the
//                                            decider also reads. Exposed
//                                            via small setters so the
//                                            wiring layer (Phase B) can
//                                            push lifecycle events in.
//   * Single entry point for the title producer: `onTitle(sid, cls, ts)`.
//       - 'running' → records runStartTs[sid], no decision.
//       - 'idle' / 'waiting' → calls decide() with a synthesized Ctx.
//                              On non-null decision, updates lastFiredTs.
//                              Always clears runStartTs after decide.
//       - 'unknown' → no-op.
//   * `forgetSid(sid)` clears every per-sid map entry in one shot
//                      (mirrors pipeline.forgetSid for the state it owns).

import { USER_INIT_MUTE_MS, type Ctx, type Decision, type Event } from './notifyDecider';

export type TitleClassification = 'idle' | 'running' | 'waiting' | 'unknown';

/**
 * "Ring the last waiting" debounce window.
 *
 * Real-world burst pattern: a long agent task issues several quick
 * permission / question prompts back-to-back (waiting → user answers in-app
 * → running → waiting → …). Pre-debounce, each waiting fired its own toast,
 * giving the user 3-5 OS notifications for a single task. Post-debounce,
 * each waiting (re)starts a 8s timer; if the title flips back to running
 * before 8s elapses (because the user answered in-app, or the CLI moved on
 * on its own), the timer is cancelled and no toast fires. Only the FINAL,
 * still-waiting prompt that has settled for 8s rings.
 *
 * Trade-off: a single long-waiting prompt is now delayed by 8s vs. fire-
 * immediately. We accept the slight latency in exchange for the burst-
 * collapse — toast spam is the louder complaint. Tune via PR if needed.
 *
 * The flash (sidebar halo) still fires IMMEDIATELY on each waiting — only
 * the OS toast is debounced. The user gets instant in-app feedback;
 * the OS-level interrupt is reserved for genuinely stuck waits.
 */
export const RING_DEBOUNCE_MS = 8_000;

export interface RunStateTrackerOptions {
  /** Override the debounce window (test only). Defaults to RING_DEBOUNCE_MS. */
  ringDebounceMs?: number;
  /** Wall-clock provider for deferred-toast fire-time re-evaluation. Defaults
   *  to Date.now. Tests inject a mock to advance time deterministically. */
  nowFn?: () => number;
  /** setTimeout / clearTimeout overrides. Default to globalThis. Tests using
   *  vi.useFakeTimers() can rely on the defaults, but explicit injection is
   *  available if a test needs a hand-rolled scheduler. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Sink callback for a deferred toast that survived the debounce window.
   *  Receives a Decision with `toast:true, flash:false` (flash already fired
   *  on the immediate path when the debounce started). */
  onDeferredToast?: (decision: Decision) => void;
}

export interface RunStateTracker {
  /** Producer entry — feed a classified title for `sid` at `nowTs`.
   *  Returns the decision the decider produced (if any) so the caller
   *  can wire sinks. Tracker itself never invokes sinks. */
  onTitle(sid: string, classification: TitleClassification, nowTs: number): Decision | null;
  /** Drop all per-sid state for `sid` (session teardown). */
  forgetSid(sid: string): void;
  /** Lifecycle setters — mirror pipeline's surface so Phase B can wire
   *  them through unchanged. Pure state mutation, no side effects. */
  setFocused(focused: boolean): void;
  setActiveSid(sid: string | null): void;
  markUserInput(sid: string, nowTs: number): void;
  /** Mute `sid` until `untilTs` (use `Infinity` for sticky). Pass
   *  `null` to clear. */
  setMuted(sid: string, untilTs: number | null): void;
  /** Cancel all pending deferred toasts (test / shutdown cleanup). */
  dispose(): void;
  /** Test-only — read internal maps for assertion. */
  _internals(): {
    runStartTs: Map<string, number>;
    mutedSids: Map<string, number>;
    lastFiredTs: Map<string, number>;
    lastUserInputTs: Map<string, number>;
    focused: boolean;
    activeSid: string | null;
    /** sids with an outstanding deferred-toast timer. */
    pendingToastSids: string[];
  };
}

export function createRunStateTracker(
  decide: (event: Event, ctx: Ctx) => Decision | null,
  options: RunStateTrackerOptions = {},
): RunStateTracker {
  const ringDebounceMs = options.ringDebounceMs ?? RING_DEBOUNCE_MS;
  const nowFn = options.nowFn ?? Date.now;
  const setTimeoutFn =
    options.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const onDeferredToast = options.onDeferredToast;

  const runStartTs = new Map<string, number>();
  /** Map<sid, untilTs> — entry present + nowTs < untilTs ⇒ sid is muted. */
  const mutedSids = new Map<string, number>();
  const lastFiredTs = new Map<string, number>();
  const lastUserInputTs = new Map<string, number>();
  /** Per-sid outstanding deferred-toast timer handle. Cancelled on:
   *    - 'running' classification (task resumed → no ring)
   *    - forgetSid (session teardown)
   *    - dispose (pipeline / process shutdown)
   *  Reset on each new waiting signal (debounce semantics — ring the LAST). */
  const pendingToastTimers = new Map<string, unknown>();
  /**
   * Per-sid gate (Task #767): true once we have observed a 'running' title
   * for this sid in the current process lifetime. The decider's Rule 2
   * ("foreground + active + short task") computes elapsed = now - start;
   * when no 'running' was ever seen, runStartTs is unset and elapsed
   * collapses to 0 < SHORT_TASK_MS, unconditionally tripping {flash:true}.
   *
   * claude.exe boot reliably emits an 'idle' / 'waiting' OSC title within
   * a few hundred ms of spawn, so without this gate every fresh / imported /
   * resumed session lights flashSink for FLASH_DURATION_MS, producing the
   * 4-second AgentIcon "breath" the user reported in #767.
   *
   * Fix at the producer layer: skip decide() entirely until we've seen a
   * legitimate run start. notifyDecider stays pure / unchanged.
   */
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

  function isMutedNow(sid: string, nowTs: number): boolean {
    const until = mutedSids.get(sid);
    return until !== undefined && nowTs < until;
  }

  function cancelPendingToast(sid: string): void {
    const t = pendingToastTimers.get(sid);
    if (t !== undefined) {
      clearTimeoutFn(t);
      pendingToastTimers.delete(sid);
    }
  }

  /**
   * Schedule (or reset) the deferred-toast timer for `sid`.
   *
   * Each fresh waiting signal pushes the fire deadline out to NOW +
   * ringDebounceMs. Burst-collapse: rapid running ↔ waiting flips never
   * exhaust the timer; only sustained waiting does.
   */
  function schedulePendingToast(sid: string): void {
    cancelPendingToast(sid);
    const handle = setTimeoutFn(() => {
      pendingToastTimers.delete(sid);
      if (!onDeferredToast) return;
      // Re-evaluate at fire-time. We deliberately do NOT re-run the full
      // decider here — runStartTs has been cleared (so Rule 2 would fire
      // flash-only and Rule 3 would never fire). Instead, re-check the
      // two dynamic suppressors that may have flipped during the wait:
      //   1. Rule 1 user-init mute (user touched this sid in last 60s)
      //   2. Rule 7 per-sid mute
      // Global mute is enforced one layer up in pipeline.ts (the pipeline
      // never feeds idle through to the tracker when global mute is on, so
      // a deferred fire on a globally-muted sid cannot happen unless the
      // mute toggled on AFTER schedule — acceptable, pipeline owns it).
      const fireTs = nowFn();
      const lastInput = lastUserInputTs.get(sid);
      if (lastInput !== undefined && fireTs - lastInput < USER_INIT_MUTE_MS) return;
      if (isMutedNow(sid, fireTs)) return;
      lastFiredTs.set(sid, fireTs);
      onDeferredToast({ toast: true, flash: false, sid });
    }, ringDebounceMs);
    pendingToastTimers.set(sid, handle);
  }

  return {
    onTitle(sid, classification, nowTs) {
      if (classification === 'unknown') return null;

      if (classification === 'running') {
        if (!runStartTs.has(sid)) runStartTs.set(sid, nowTs);
        hasObservedRunning.add(sid);
        // Cancel any pending deferred toast — the task moved on, the user
        // (or the CLI) already handled the previous waiting signal.
        cancelPendingToast(sid);
        return null;
      }

      // Task #767 gate: if we've never seen this sid go 'running', the
      // incoming 'idle' / 'waiting' title is the CLI's boot banner (or a
      // post-import resume settle). There is no real task to notify on, and
      // the decider would otherwise mis-fire Rule 2 (elapsed = 0 < 60s).
      if (!hasObservedRunning.has(sid)) {
        // Still keep runStartTs clean if anything stray slipped in.
        runStartTs.delete(sid);
        return null;
      }

      // 'idle' or 'waiting' → ask the decider.
      // The decider matches against the literal word "waiting"; both
      // classifications represent the same user-attention signal, so we
      // normalize to that token regardless of which one the producer
      // emitted.
      const ctx: Ctx = {
        focused,
        activeSid,
        lastUserInputTs,
        runStartTs,
        mutedSids: activeMutedSet(nowTs),
        lastFiredTs,
        now: nowTs,
      };
      const event: Event = { type: 'osc-title', sid, title: 'waiting', ts: nowTs };
      const immediate = decide(event, ctx);

      // Mirror pipeline behaviour: always clear runStartTs after a
      // non-running title so the next run starts a fresh elapsed clock.
      runStartTs.delete(sid);

      // Debounce-style "ring the LAST waiting": any waiting signal that
      // would otherwise toast (re)starts the deferred-toast timer.
      // We trigger the schedule when EITHER:
      //   - decide() returned toast:true (the original "yes, toast" path), OR
      //   - decide() returned null AND a deferred toast is already pending
      //     (a follow-up waiting inside a burst — even if the immediate
      //     decision was suppressed by 5s dedupe, we still want the timer
      //     pushed out so the LAST waiting wins).
      // We do NOT schedule when the sid is currently muted (no point
      // firing later either — re-eval at fire-time would suppress anyway,
      // and avoiding the timer keeps the pending-set tidy).
      const shouldDefer =
        !isMutedNow(sid, nowTs) &&
        ((immediate !== null && immediate.toast) || pendingToastTimers.has(sid));
      if (shouldDefer) {
        schedulePendingToast(sid);
      }

      if (immediate !== null) {
        lastFiredTs.set(sid, nowTs);
        if (immediate.toast) {
          // Strip the toast from the immediate fan-out — it will fire (or
          // not) via the deferred path. Flash still fires immediately so
          // the in-app halo is instant.
          return { toast: false, flash: immediate.flash, sid };
        }
        return immediate;
      }
      return null;
    },
    forgetSid(sid) {
      runStartTs.delete(sid);
      mutedSids.delete(sid);
      lastFiredTs.delete(sid);
      lastUserInputTs.delete(sid);
      hasObservedRunning.delete(sid);
      cancelPendingToast(sid);
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
      for (const handle of pendingToastTimers.values()) clearTimeoutFn(handle);
      pendingToastTimers.clear();
    },
    _internals() {
      return {
        runStartTs,
        mutedSids,
        lastFiredTs,
        lastUserInputTs,
        focused,
        activeSid,
        pendingToastSids: Array.from(pendingToastTimers.keys()),
      };
    },
  };
}
