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

import type { Ctx, Decision, Event } from './notifyDecider';

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
): RunStateTracker {
  const runStartTs = new Map<string, number>();
  /** Map<sid, untilTs> — entry present + nowTs < untilTs ⇒ sid is muted. */
  const mutedSids = new Map<string, number>();
  const lastFiredTs = new Map<string, number>();
  const lastUserInputTs = new Map<string, number>();
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
      }
      return decision;
    },
    forgetSid(sid) {
      runStartTs.delete(sid);
      mutedSids.delete(sid);
      lastFiredTs.delete(sid);
      lastUserInputTs.delete(sid);
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
