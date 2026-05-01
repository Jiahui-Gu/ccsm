// T26 — Marker-aware crash-loop skip decider.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//   §6.1 R2 + §6.4 marker semantics:
//     "Marker file present at boot time = "the previous daemon shutdown
//      was for upgrade, expected and clean — do NOT increment the
//      crash-loop counter (§6.1 R2 rule), do NOT trip the rollback path
//      (§6.4 step 7 .bak swap), do NOT surface `daemon.crashLoop` modal."
//     "Marker file absent at boot = "previous shutdown was either crash,
//      OS reboot, user-Quit, or first-ever boot — apply normal supervisor
//      crash-loop accounting per §6.1 R2."
//     "Marker corruption / partial write (rel-S-R8): treat as PRESENT."
//
// Single Responsibility (per feedback_single_responsibility):
//   This is a PURE DECIDER. It takes a marker snapshot + a "consumed"
//   flag (set by the caller after first inspection on a given boot
//   pass) and returns a boolean: "should the supervisor SKIP its
//   crash-loop accounting on this restart event?".
//
//   The module does NOT:
//     - read the marker (T22 `daemon/src/marker/reader.ts` does that)
//     - mutate state (the caller owns the consumed-flag lifecycle)
//     - perform side effects (no logging, no IPC, no fs)
//
// Wiring (deferred):
//   The supervisor's crash-loop tracker (frag-6-7 §6.1 — "≥5 respawns
//   within a sliding 2-minute window") does not yet exist in this repo.
//   Per Task #983 brief, the supervisor lives in T63 nodemon-host work.
//   When that lands, the supervisor will:
//     1. On first boot of each supervisor lifetime, call `readMarker()`
//        once and capture the snapshot.
//     2. Pass that snapshot + `consumed=false` into
//        `shouldSkipCrashLoop()` on the FIRST restart-bookkeeping pass.
//     3. After the first pass (regardless of skip outcome), set
//        `consumed=true` and unlink the marker (per spec §6.4
//        consumption rule).
//     4. Subsequent restart events in the same supervisor lifetime see
//        `consumed=true` → normal crash-loop counting resumes.
//
//   See `crash-loop-skip-wiring.ts` for the wiring stub that the
//   supervisor module will import once it exists.
//
// TODO(T63): wire this decider into the nodemon supervisor restart hook
// once the supervisor module lands. Spec section will be added to
// frag-6-7 §6.1 (PUNT noted in spec line 118).

import type { MarkerReadResult } from '../marker/reader.js';

/**
 * Snapshot of the marker file as observed at supervisor first-boot.
 * This is exactly the result of `readMarker()` — passed through so the
 * decider remains pure (no fs).
 */
export type MarkerSnapshot = MarkerReadResult;

/**
 * Inputs to the skip decider. All fields are immutable — the caller
 * owns the lifecycle of `consumed`.
 */
export interface CrashLoopSkipInput {
  /** Result of `readMarker()` taken at supervisor first-boot. */
  marker: MarkerSnapshot;
  /**
   * Whether the marker has already been "consumed" on this supervisor
   * lifetime (set true by caller AFTER the first crash-loop accounting
   * pass that observed it). Spec §6.4: marker is one-shot — consumed
   * on first inspection, then unlinked.
   */
  consumed: boolean;
  /**
   * Current restart counter value the supervisor is about to act on.
   * Surfaced as an input for forensics / future spec evolution; the
   * v0.3 rule itself is binary (marker PRESENT → skip), so this value
   * is currently unused by the decision logic. Kept in the signature
   * so callers don't need to refactor when §6.1 R2 grows nuance.
   */
  restartCount: number;
}

/**
 * Return true when the supervisor should SKIP its crash-loop counter
 * increment for the current restart event. Pure function: same input
 * → same output, no side effects.
 *
 * Decision table (single source of truth, mirrors spec §6.4):
 *
 *   marker.kind   consumed   -> skip
 *   ---------------------------------
 *   'absent'      *          -> false   // normal accounting
 *   'present'     false      -> true    // first-boot bypass
 *   'present'     true       -> false   // already consumed; resume
 *
 * Corruption handling: `readMarker()` already collapses every
 * non-ENOENT condition (empty file, invalid JSON, missing fields,
 * io-error) into `{ kind: 'present', reason }`. Therefore this
 * decider gets corruption-treat-as-PRESENT semantics for free — the
 * `kind === 'present'` branch fires regardless of `reason`.
 */
export function shouldSkipCrashLoop(input: CrashLoopSkipInput): boolean {
  if (input.marker.kind === 'absent') {
    return false;
  }
  // marker.kind === 'present' — covers valid payload AND every
  // corruption reason (empty / invalid-json / missing-fields /
  // io-error) per T22 reader contract.
  return input.consumed === false;
}
