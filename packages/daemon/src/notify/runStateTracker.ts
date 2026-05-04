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

import type { Ctx, Decision, Event } from './notifyDecider.js';
import type { NotifyEventBus } from './event-bus.js';

export type TitleClassification = 'idle' | 'running' | 'waiting' | 'unknown';

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
  /** Test-only — read internal maps for assertion. */
  _internals(): {
    runStartTs: Map<string, number>;
    mutedSids: Map<string, number>;
    lastFiredTs: Map<string, number>;
    lastUserInputTs: Map<string, number>;
    focused: boolean;
    activeSid: string | null;
  };
}

export function createRunStateTracker(
  decide: (event: Event, ctx: Ctx) => Decision | null,
  /**
   * Optional event bus. When provided, every non-null decision is also
   * published as a `NotifyEvent` so subscribers (future
   * `WatchNotifyEvents` handler — audit #228 sub-task 8) can stream
   * decider firings without re-running the decider.
   *
   * The bus is wired here, at the SOLE call site of `decide()`, so a
   * future change to the decider's invocation surface cannot drift the
   * emit point off the decision path. Pure additive — when the bus is
   * omitted (every existing test passes `decide` only), behaviour is
   * unchanged.
   */
  eventBus?: NotifyEventBus,
): RunStateTracker {
  const runStartTs = new Map<string, number>();
  /** Map<sid, untilTs> — entry present + nowTs < untilTs ⇒ sid is muted. */
  const mutedSids = new Map<string, number>();
  const lastFiredTs = new Map<string, number>();
  const lastUserInputTs = new Map<string, number>();
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

  return {
    onTitle(sid, classification, nowTs) {
      if (classification === 'unknown') return null;

      if (classification === 'running') {
        if (!runStartTs.has(sid)) runStartTs.set(sid, nowTs);
        hasObservedRunning.add(sid);
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
      const decision = decide(event, ctx);

      // Mirror pipeline behaviour: always clear runStartTs after a
      // non-running title so the next run starts a fresh elapsed clock.
      runStartTs.delete(sid);

      if (decision !== null) {
        lastFiredTs.set(sid, nowTs);
        // Single emit point for the whole notify pipeline. Mirrors
        // `SessionManager.create`/`destroy` calling `bus.publish` after
        // the state mutation — see `sessions/event-bus.ts` design notes.
        eventBus?.emitNotifyEvent({
          sid,
          toast: decision.toast,
          flash: decision.flash,
          ts: nowTs,
        });
      }
      return decision;
    },
    forgetSid(sid) {
      runStartTs.delete(sid);
      mutedSids.delete(sid);
      lastFiredTs.delete(sid);
      lastUserInputTs.delete(sid);
      hasObservedRunning.delete(sid);
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
    _internals() {
      return {
        runStartTs,
        mutedSids,
        lastFiredTs,
        lastUserInputTs,
        focused,
        activeSid,
      };
    },
  };
}
