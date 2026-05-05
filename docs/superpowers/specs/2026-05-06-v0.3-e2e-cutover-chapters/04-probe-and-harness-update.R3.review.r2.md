# Review of chapter 04: Probe and harness update (round 2)

Reviewer: R3 (reliability / observability)
Round: r2

## Round-1 closures

- **P1-1 (`waitForTerminalReady` timeout dump insufficient — daemon-side
  state invisible)** — CLOSED by CF-5 + CF-6. `04-probe-and-harness-update.md`
  §2 `waitForTerminalReady` now dumps `window.__ccsmHydrationTrace`
  (full extended shape per ch02 §4) to
  `tmp/e2e-logs/<run-id>/<case>.hydration-trace.json` on timeout, AND
  the per-case daemon stderr capture (CF-6 below) carries the
  daemon-side `[ccsmd] <ISO> <level> <category>: ...` records. The
  round-1 finding asked for hydration trace + daemon stderr tail; both
  are now wired. The proposed `_debug/state` daemon RPC was a stretch
  ask and is not required because the hydration trace + stderr
  records carry sufficient signal for the documented failure modes
  (`host:true, term:true, buffer:false`); leaving the debug RPC out
  is acceptable and not a regression.
- **P1-2 (no per-case daemon stderr capture)** — CLOSED by CF-6. §2
  "Daemon stderr capture" subsection pins:
  (a) per-case file at `tmp/e2e-logs/<run-id>/<case>.electron.log`;
  (b) `<run-id>` = ISO-second-precision timestamp, gitignored;
  (c) on case FAIL: tail last 200 lines, `error`-level records first,
  prepended into the case error message;
  (d) best-effort capture (I/O failure does NOT fail an
  otherwise-passing case).
  The capture loop with ch00 §6 acceptance and ch05 §1 G11 grep is
  closed.
- **P1-3 (`daemon-port-ready-before-render` assertion under-specified)** —
  CLOSED by CF-7. §4 case row now reads "first RPC ≤500ms wall-clock
  AND `window.__ccsmDaemonPortLoadIterations === 0`" with the debug
  counter pinned by `electron/preload/bridges/ccsmPty.ts` per ch03 §3
  fallback poll. The two-pronged assertion catches both silent
  regression to Option-A polling (counter > 0) and latency regression
  without polling (wall-clock > 500ms). Total case budget ≤5s.

## Findings

No new P0/P1 from R3 in round 2.

Round-1 P2-1 (`reset-between-cases.mjs` daemon-PID liveness check) was
a P2 in round 1, properly forward-referenced from ch01 HP-12 (F-01)
with v0.4 promotion gated on a v0.3 incident. Not re-raised.

### Notes (not P0/P1)

- The `<run-id>` is ISO-second-precision; if a developer re-invokes
  the harness within the same wall-clock second the directory would
  collide. v0.3 e2e is run sequentially in CI (not in parallel within
  the same job), so this is not a reliability risk in scope. A v0.4
  hardening pass may add per-invocation random suffix; out of scope.
- The G11 grep regex in ch05 §1 (`\] [0-9T:.\-]+Z error `) anchors on
  the structured-line shape, so unstructured Electron warnings that
  happen to contain the literal word "error" will not false-positive.
  This was a concern at the spec-design level; the regex anchoring
  resolves it.

## Cross-file findings

None. All R3 round-1 ch04 findings closed in coordination with ch00 /
ch02 / ch03 / ch05 already.
