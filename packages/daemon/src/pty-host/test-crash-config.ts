// Test-only crash branch parser (T4.5 / Task #40).
//
// Spec ref: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
// ch06 §1 — "Test-only crash branch (FOREVER-STABLE)":
//
//   the pty-host child entrypoint reads env `CCSM_PTY_TEST_CRASH_ON`
//   (set ONLY by the test harness; daemon production code never sets
//   it). When set to e.g. `after-bytes:1024`, the pty-host child calls
//   `process.exit(137)` after the first 1024 bytes of `claude` output
//   cross the IPC boundary. This branch is gated by
//   `if (process.env.NODE_ENV !== 'production')` AND the env var
//   presence; production sea builds strip the branch via `tsc`
//   dead-code elimination since the env-var name is a string literal
//   compared against an undefined env in production.
//
// Why a separate decider module (SRP, dev.md §3):
//   - child.ts is a *sink/orchestrator* for IPC messages. The "should
//     this event trigger a test crash?" question is a pure decision
//     over (env var contents, current event, accumulated counters).
//     Keeping the parse + matching here means child.ts only adds a
//     one-line `if (decider.shouldCrash(...)) process.exit(137)` per
//     hook point; the matrix of supported events lives in one place
//     so adding a new event (e.g. `after-deltas:N`) when T4.6 wires
//     node-pty does NOT touch child.ts.
//   - Pure deciders are unit-testable without forking a real child.
//     The integration spec (`child-test-crash.spec.ts`) only needs to
//     verify "env present + matching event → process really exits 137",
//     not the parse matrix.
//
// Layer 1 — alternatives checked:
//   - Inline the parse in child.ts: rejected. Mixes a string parser
//     with the IPC orchestrator and forces every test-crash event
//     addition to touch child.ts.
//   - Extend the existing `resolveCapForTest` env-pattern in child.ts
//     and inline the crash branch: rejected for the same SRP reason —
//     `resolveCapForTest` returns a number; this returns a closed
//     union and runs at multiple hook points.
//   - Use a regex like `/^after-bytes:(\d+)$/` and ad-hoc `==='spawn'`
//     in each hook: rejected — the union grows per spec §4 wording so
//     centralizing the matcher is the cheaper long-term shape.
//
// Forward-compat (v0.4): adding a new event kind here is purely
// additive; child.ts just needs one new `maybeTriggerTestCrashOn(...)`
// call site. The env var name itself is FOREVER-STABLE.

/**
 * Parsed shape of the `CCSM_PTY_TEST_CRASH_ON` env var.
 *
 * The discriminant is a string literal so a `switch` is exhaustive;
 * each variant carries the parameters that variant needs (e.g.
 * `afterBytes` carries the threshold). Adding a v0.4 variant is purely
 * additive; do NOT renumber.
 *
 * Variant catalogue (v0.3):
 *   - `boot`         : crash immediately as soon as the child reaches
 *                      its `ready` send. Lets the integration test
 *                      assert "the daemon classifies a never-ready
 *                      child as CRASHED" without needing a real
 *                      `claude` to spawn.
 *   - `spawn`        : crash on the first `spawn` IPC the host sends.
 *                      Models "node-pty.spawn threw" without depending
 *                      on the unfinished T4.6 wiring.
 *   - `after-bytes:N`: crash after the cumulative outgoing IPC payload
 *                      to the host crosses N bytes. Spec §4's named
 *                      example. v0.3 child.ts does not yet stream
 *                      `claude` deltas (T4.6+ wires that), so the
 *                      counter increments on EVERY child→host message
 *                      payload until then. When T4.6 lands the counter
 *                      will naturally include the delta payloads with
 *                      no decider change required.
 */
export type TestCrashConfig =
  | { readonly kind: 'boot' }
  | { readonly kind: 'spawn' }
  | { readonly kind: 'after-bytes'; readonly threshold: number };

/**
 * Crash exit code the child uses when this branch fires. Spec §4
 * names `137` (the conventional "killed by SIGKILL" exit code, which
 * matches what the lifecycle watcher would observe for a real OOM-
 * killer / supervisor-kill). Tests assert on `137` so any drift from
 * spec is caught.
 */
export const TEST_CRASH_EXIT_CODE = 137;

/**
 * Pure parser — return a `TestCrashConfig` if the env var is set AND
 * we are NOT running in production AND the value matches a known
 * variant. Returns `null` in every other case (no env, prod, malformed
 * value). The dual gate (NODE_ENV !== 'production' AND env presence)
 * is the spec's literal wording so a misconfigured prod env that
 * accidentally sets the var still cannot crash a user.
 *
 * Inputs are explicit (not read from `process.env`) so the parser is
 * a pure function — trivial to unit-test, no module-load side effects.
 *
 * @param raw      The literal value of `process.env.CCSM_PTY_TEST_CRASH_ON`
 *                 (`undefined` when unset). Empty string is treated as
 *                 "unset" — a value of `""` is meaningless and likely
 *                 a misconfigured shell, NOT a request to crash.
 * @param nodeEnv  The literal value of `process.env.NODE_ENV`. Anything
 *                 other than the exact string `"production"` allows the
 *                 branch to activate (matches `if (NODE_ENV !==
 *                 'production')` in the spec wording).
 */
export function parseTestCrashEnv(
  raw: string | undefined,
  nodeEnv: string | undefined,
): TestCrashConfig | null {
  // Production gate FIRST — even a malformed value in production must
  // not allocate / log / branch. Returning null is the no-op path.
  if (nodeEnv === 'production') return null;
  if (raw === undefined || raw === '') return null;

  if (raw === 'boot') return { kind: 'boot' };
  if (raw === 'spawn') return { kind: 'spawn' };

  // `after-bytes:<positive integer>` — single supported parametric
  // variant in v0.3.
  if (raw.startsWith('after-bytes:')) {
    const tail = raw.slice('after-bytes:'.length);
    // Reject empty tail, sign chars, non-digits, leading zeros (so the
    // wire format is unambiguous; `after-bytes:00010` is malformed).
    if (!/^[1-9]\d*$/.test(tail)) return null;
    const threshold = Number.parseInt(tail, 10);
    if (!Number.isSafeInteger(threshold) || threshold <= 0) return null;
    return { kind: 'after-bytes', threshold };
  }

  // Unknown variants → silently no-op. The test harness controls this
  // env var so a typo surfaces as "the test that expected a crash
  // didn't get one"; logging from production code on every child boot
  // would be noise.
  return null;
}

/**
 * Mutable byte accumulator the `after-bytes` variant uses. A separate
 * tiny class (not a free function) so child.ts owns ONE instance per
 * child and the test integration can construct one without standing
 * up the whole child.ts module.
 *
 * Pure-decider: `addAndShouldCrash` is the only state mutation; given
 * the same `(running, addBytes, threshold)` it always returns the same
 * `(newRunning, shouldCrash)` pair.
 */
export class TestCrashByteCounter {
  private running = 0;

  /**
   * Add `bytes` to the cumulative counter. Returns true the FIRST time
   * the cumulative total reaches or exceeds `threshold` (and only that
   * time — the caller is expected to `process.exit(137)` immediately
   * so subsequent calls cannot happen, but if they did this still
   * returns true so a buggy caller still crashes deterministically).
   *
   * The "reaches or exceeds" comparison is `>=` (not `>`) so that
   * `after-bytes:1024` with a single 1024-byte payload triggers a
   * crash on that payload, matching the spec wording "after the first
   * 1024 bytes ... cross the IPC boundary".
   */
  addAndShouldCrash(bytes: number, threshold: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    this.running += bytes;
    return this.running >= threshold;
  }

  /** Read-only accessor for tests / log lines. */
  get cumulative(): number {
    return this.running;
  }
}

/**
 * Estimate the byte size of a child→host IPC payload for the
 * `after-bytes` accounting. `child_process.fork` serializes messages
 * via JSON (the v8 advanced serializer is opt-in; we are on the
 * default), so the IPC byte count IS the JSON byte length. Uint8Array
 * payloads (delta bytes once T4.6 wires them) are encoded by the
 * default serializer as `{ type: 'Buffer', data: [ ... ] }`, which
 * inflates the wire size; we approximate with the raw byte length
 * since the spec wording counts "bytes of `claude` output" not "wire
 * bytes". Approximation is safe — the spec value (1024) is an order
 * of magnitude away from any boundary that matters.
 */
export function estimateIpcPayloadBytes(msg: unknown): number {
  if (msg === null || msg === undefined) return 0;
  // Fast path for the only payload type that carries large bytes
  // through the IPC today (Uint8Array on `send-input` is host→child;
  // child→host this lands once T4.6 wires `delta`).
  if (msg instanceof Uint8Array) return msg.byteLength;
  if (typeof msg === 'object') {
    const obj = msg as Record<string, unknown>;
    // Look for a `bytes: Uint8Array` field at the top level (the
    // shape the future delta message will use); count those bytes
    // directly so the spec's "claude output bytes" semantics hold.
    const b = obj['bytes'];
    if (b instanceof Uint8Array) return b.byteLength;
  }
  // Fallback: JSON length is an upper-bound proxy for "amount of data
  // crossing the IPC channel" for non-binary messages.
  try {
    return JSON.stringify(msg).length;
  } catch {
    return 0;
  }
}
