/**
 * Notify decider — pure function mapping (event, ctx) to a notify Decision.
 *
 * 7-rule spec (user-confirmed):
 *
 * | # | trigger                                                                       | toast | flash |
 * |---|-------------------------------------------------------------------------------|-------|-------|
 * | 1 | user just acted on this sid (new/import/resume/switch) within 60s, OSC waits  |   x   |   x   |
 * | 2 | ccsm focused + viewing this sid + task duration < 60s                         |   x   |   v   |
 * | 3 | ccsm focused + viewing this sid + task duration >= 60s                        |   v   |   v   |
 * | 4 | ccsm focused + viewing other sid (background sid finishes)                    |   v   |   v   |
 * | 5 | ccsm not focused (window unfocused/minimized)                                 |   v   |   v   |
 * | 6 | multi-sid background concurrent finishes — each sid evaluated independently   |  per  |  per  |
 * | 7 | sid muted — toast suppressed but flash still fires                            |   x   |   v   |
 *
 * Dedupe: same sid within 5s suppressed entirely (returns null).
 * Short-task threshold: 60s (from runStartTs).
 *
 * `decide` is pure — does NOT mutate ctx. Callers maintain ctx state
 * (this is wired up by the pipeline / sink layer in #689).
 */

export const USER_INIT_MUTE_MS = 60_000;
export const SHORT_TASK_MS = 60_000;
export const DEDUPE_MS = 5_000;

export type Event =
  | { type: 'osc-title'; sid: string; title: string; ts: number }
  | { type: 'window-focus-change'; focused: boolean }
  | { type: 'active-sid-change'; sid: string | null }
  | { type: 'user-input'; sid: string; ts: number };

export interface Ctx {
  focused: boolean;
  activeSid: string | null;
  /** per-sid last "user touched this session" timestamp (ms epoch) */
  lastUserInputTs: Map<string, number>;
  /** per-sid current run start timestamp (ms epoch); cleared on idle/waiting */
  runStartTs: Map<string, number>;
  mutedSids: Set<string>;
  /** per-sid last toast fire timestamp (ms epoch), used for 5s dedupe */
  lastFiredTs: Map<string, number>;
  /** injected current time for test determinism */
  now: number;
}

export type Decision = { toast: boolean; flash: boolean; sid: string };

export type RuleKey =
  | 'user-init-mute'
  | 'foreground-active-short'
  | 'foreground-active-long'
  | 'foreground-other-sid'
  | 'unfocused'
  | 'muted';

/**
 * Returns true iff the given OSC title indicates the CLI is waiting for
 * user input (the moment we want to notify on).
 *
 * The producer (#688) emits 'osc-title' events with the raw title string;
 * we treat any title containing "waiting" (case-insensitive) as the
 * waiting signal. This is intentionally permissive — the producer is
 * expected to filter to actual transitions.
 */
function isWaitingTitle(title: string): boolean {
  return /waiting/i.test(title);
}

/**
 * Evaluate the 7 rules for an OSC waiting event.
 * Returns the matched RuleKey + raw (toast, flash) before dedupe.
 */
function evalRules(
  sid: string,
  ctx: Ctx,
): { rule: RuleKey; toast: boolean; flash: boolean } {
  const { now, focused, activeSid, lastUserInputTs, runStartTs, mutedSids } = ctx;

  // Rule 1: user-init mute — user touched this sid within 60s
  const lastInput = lastUserInputTs.get(sid);
  if (lastInput !== undefined && now - lastInput < USER_INIT_MUTE_MS) {
    return { rule: 'user-init-mute', toast: false, flash: false };
  }

  // Rule 7: muted sid — flash still fires, toast suppressed
  // (Evaluated before foreground rules so muted sids never toast,
  //  even when active+visible. Flash semantics fall out of which
  //  rule would otherwise apply, so we still compute the base decision.)
  const muted = mutedSids.has(sid);

  // Rule 5: not focused → toast + flash
  if (!focused) {
    const decision = { toast: true, flash: true };
    return muted
      ? { rule: 'muted', toast: false, flash: decision.flash }
      : { rule: 'unfocused', ...decision };
  }

  // Foreground from here on.
  // Rule 4: focused but viewing different sid → toast + flash
  if (activeSid !== sid) {
    const decision = { toast: true, flash: true };
    return muted
      ? { rule: 'muted', toast: false, flash: decision.flash }
      : { rule: 'foreground-other-sid', ...decision };
  }

  // Foreground + viewing this sid: split by task duration.
  const start = runStartTs.get(sid);
  const elapsed = start === undefined ? 0 : now - start;

  if (elapsed < SHORT_TASK_MS) {
    // Rule 2: short task → flash only, no toast
    const decision = { toast: false, flash: true };
    return muted
      ? { rule: 'muted', toast: false, flash: decision.flash }
      : { rule: 'foreground-active-short', ...decision };
  }

  // Rule 3: long task → toast + flash
  const decision = { toast: true, flash: true };
  return muted
    ? { rule: 'muted', toast: false, flash: decision.flash }
    : { rule: 'foreground-active-long', ...decision };
}

/**
 * DEV-only invariant assertion on Ctx shape (audit #876 cluster 2.2).
 *
 * Intent: catch wiring bugs at the seam between pipeline / runStateTracker
 * and the pure decider. The decider never narrows these types at runtime,
 * so a stray `undefined` / number / wrong-collection slipping through
 * silently mis-fires Rule 2 ("elapsed = 0 < 60s") and lights flashSink
 * for every fresh sid (the original #767 class of bug).
 *
 * Production builds skip this — the call site is gated on NODE_ENV. Tests
 * import it directly to exercise the failure paths.
 */
export function assertNotifyContext(ctx: Ctx): void {
  if (typeof ctx !== 'object' || ctx === null) {
    throw new Error(`notifyDecider: ctx must be an object, got ${typeof ctx}`);
  }
  if (typeof ctx.focused !== 'boolean') {
    throw new Error(
      `notifyDecider: ctx.focused must be boolean, got ${typeof ctx.focused}`,
    );
  }
  if (ctx.activeSid !== null && typeof ctx.activeSid !== 'string') {
    throw new Error(
      `notifyDecider: ctx.activeSid must be string|null, got ${typeof ctx.activeSid}`,
    );
  }
  if (typeof ctx.now !== 'number' || !Number.isFinite(ctx.now)) {
    throw new Error(
      `notifyDecider: ctx.now must be a finite number, got ${ctx.now}`,
    );
  }
  if (!(ctx.lastUserInputTs instanceof Map)) {
    throw new Error('notifyDecider: ctx.lastUserInputTs must be a Map');
  }
  if (!(ctx.runStartTs instanceof Map)) {
    throw new Error('notifyDecider: ctx.runStartTs must be a Map');
  }
  if (!(ctx.lastFiredTs instanceof Map)) {
    throw new Error('notifyDecider: ctx.lastFiredTs must be a Map');
  }
  if (!(ctx.mutedSids instanceof Set)) {
    throw new Error('notifyDecider: ctx.mutedSids must be a Set');
  }
}

/**
 * Notification decision matrix (audit #876 cluster 2.2).
 *
 * 5 dimensions feed the decision (the first 3 live in Ctx; `muted` is per-sid
 * via ctx.mutedSids; `globalMuted` is enforced one layer up in pipeline.ts
 * before the tracker is even called):
 *
 *   focused              - BrowserWindow focus state
 *   activeSid===sid      - is the renderer currently viewing this sid?
 *   hasObservedRunning   - tracker-level gate; has this sid ever gone
 *                          'running' in this process? (#767 boot-banner fix)
 *   muted                - per-sid mute (ctx.mutedSids); set permanently by
 *                          pipeline.markUserInput (see pipeline.ts ~line 178)
 *                          and toggled by setMuted IPC
 *   globalMuted          - app-wide mute (pipeline.isGlobalMutedFn)
 *
 * Plus two additional gates the decider applies last:
 *   userInputRecent      - Rule 1 (lastUserInputTs[sid] within 60s)
 *   dedupe               - 5s per-sid suppression on lastFiredTs
 *
 * | focused | active | hasRun | muted | global | result        | rule        |
 * |---------|--------|--------|-------|--------|---------------|-------------|
 * | *       | *      | *      | *     | T      | null          | global gate |
 * | *       | *      | F      | *     | F      | null          | #767 gate   |
 * | *       | *      | T      | *     | F      | null (R1)     | user-init   |
 * | F       | *      | T      | F     | F      | toast + flash | R5          |
 * | F       | *      | T      | T     | F      | flash only    | R7 (muted)  |
 * | T       | F      | T      | F     | F      | toast + flash | R4          |
 * | T       | F      | T      | T     | F      | flash only    | R7 (muted)  |
 * | T       | T      | T      | F     | F      | flash only    | R2 (<60s)   |
 * | T       | T      | T      | F     | F      | toast + flash | R3 (>=60s)  |
 * | T       | T      | T      | T     | F      | flash only    | R7 (muted)  |
 *
 * After rule eval, a 5s per-sid dedupe (DEDUPE_MS) collapses any
 * still-positive decision back to null if lastFiredTs[sid] is recent.
 *
 * Hidden side effect to be aware of:
 *   pipeline.markUserInput() (sinks/pipeline.ts ~line 178) sets a PERMANENT
 *   mute (untilTs = +Infinity). Rationale: when the user creates / imports /
 *   resumes a session, that's an explicit attention act and further toasts
 *   on that sid would interrupt rather than help. The mute is cleared only
 *   on forgetSid (session teardown) or an explicit setMuted(false) IPC.
 *
 * `decide` itself remains pure — it does not mutate ctx, does not perform
 * I/O, and returns the same Decision for the same (event, ctx) input.
 */
export function decide(event: Event, ctx: Ctx): Decision | null {
  if (process.env.NODE_ENV !== 'production') {
    assertNotifyContext(ctx);
  }

  // Context-update-only events produce no decision; the caller is
  // responsible for updating ctx.
  if (event.type !== 'osc-title') {
    return null;
  }

  if (!isWaitingTitle(event.title)) {
    return null;
  }

  const { sid } = event;
  const result = evalRules(sid, ctx);

  // If neither toast nor flash, nothing to fire.
  if (!result.toast && !result.flash) {
    return null;
  }

  // 5s dedupe per sid — suppress entirely if last fire was < 5s ago.
  const lastFired = ctx.lastFiredTs.get(sid);
  if (lastFired !== undefined && ctx.now - lastFired < DEDUPE_MS) {
    return null;
  }

  return { toast: result.toast, flash: result.flash, sid };
}
