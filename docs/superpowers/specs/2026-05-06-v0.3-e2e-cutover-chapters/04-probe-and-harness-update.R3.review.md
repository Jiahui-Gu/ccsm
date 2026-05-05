# Review of chapter 04: Probe and harness update

Reviewer: R3 (reliability / observability)
Round: r1

## Findings

### P1-1 (must-fix): `waitForTerminalReady` "DOM dump on timeout" is the only debug aid; insufficient for daemon-side hangs

**Where**: chapter 04, §2 "scripts/probe-utils-real-cli.mjs — `waitForTerminalReady`" (lines 134-148).
**Issue**: §2 says "Add a one-time DOM dump on timeout (`win.content().slice(0,500)` in the error message)". This catches renderer-side wedge but reveals nothing about daemon state. When `host:true, term:true, buffer:false` (the most-likely failure after PR-6 lands), the diagnostic is a renderer DOM that proves the renderer is fine — operator still has no idea WHY no SSE event arrived.
**Why this is P1**: this is exactly the failure mode the SSE reconnect P0 in chapter 03 review aims at. When it incidents in CI, the harness needs to dump the *daemon-side* state too.
**Suggested fix**: extend the timeout error path to also fetch and dump:
  - `window.__ccsmHydrationTrace` JSON (per chapter 02 review P1-2 extension).
  - The result of a debug RPC `GET /api/pty/_debug/state?sid=<sid>` (NEW; daemon-side small handler that returns `{ pid, exitedAt, lastEmitSeq, subscriberCount, snapshotBytes }`). Define this in chapter 03 (it's a debug surface) and consume in chapter 04.
  - The last 50 lines of the per-case daemon stderr capture (cross-ref chapter 03 P1-3 log format).

### P1-2 (must-fix): no contract for capturing daemon stderr per harness case

**Where**: chapter 04, §2 "scripts/probe-helpers/harness-runner.mjs" (lines 152-160) and §6 "Acceptance signal".
**Issue**: §2 only mentions `skipLaunch` capability validation. There is no requirement that harness-runner pipes electron-spawned daemon's stderr to a per-case file. Today, daemon stderr disappears (electron eats it; harness doesn't capture). When CI flakes the only signal is the Playwright video.
**Why this is P1**: closes the observability loop opened by chapter 00 P1-2 and chapter 03 P1-3. Without this, the structured logs in chapter 03 §6 land but are invisible.
**Suggested fix**: §2 new bullet: "harness-runner MUST capture electron child's stdout+stderr to `tmp/e2e-logs/<run-id>/<case>.electron.log` and (since electron forwards daemon stderr — chapter 03 §6) the daemon trail will be interleaved there. On case failure, the runner MUST tail the last 200 lines into the case error message. On success, files are kept for 24h then GC'd."

### P1-3 (must-fix): `daemon-port-ready-before-render` new case under-specifies the reliability assertion

**Where**: chapter 04, §4 "New harness cases required by spec" — `daemon-port-ready-before-render` row (lines 209-213).
**Issue**: The asserts column says "`window.ccsmPty` works on the very first RPC (no 5s polling waste)". But "works" is fuzzy. Does it mean: zero polling iterations consumed (proves Option C took effect)? Or just that the first RPC returns within X ms? These are different reliability invariants.
**Why this is P1**: without sharper assertion, the case will pass even if Option C silently regresses to Option A behaviour (poll + succeed at iteration 5).
**Suggested fix**: pin the assertion: "On harness app launch, assert `await window.ccsmPty.checkClaudeAvailable()` resolves within 500ms wall-clock from page-load. AND assert `window.__ccsmDaemonPortLoadIterations === 0` (NEW debug counter pinned by `electron/preload/bridges/ccsmPty.ts`; chapter 03 §3 must add this counter exposing how many fallback poll iterations were consumed). Why: directly gates Option C correctness."

### P2-1 (nice-to-have): reset-between-cases.mjs check for daemon-PID liveness implied but not specified

**Where**: chapter 04, §2 "scripts/probe-helpers/reset-between-cases.mjs" (lines 161-166).
**Issue**: Chapter 01 HP-12 daemon-leak detection (R3 P1 in chapter 01 review) needs a reset-between-cases hook. Chapter 04 §2 currently only checks store reference identity.
**Why this is P2**: tracked under chapter 01 P1-1; this is the implementation site. Listed as P2 here to avoid double-counting.
**Suggested fix**: cross-reference chapter 01 P1-1; the reset hook MUST log spawned daemon PIDs and assert previous case's PID is reaped within 5s (`process.kill(pid, 0)` throws ESRCH).

## Cross-file findings

- P1-1 (timeout dump) needs the debug RPC defined in chapter 03 + the trace extension from chapter 02 review. One fixer to plumb.
- P1-2 (stderr capture) closes the loop with chapter 00 P1-2 and chapter 03 P1-3. One fixer for the trio.
- P1-3 (debug counter) requires a small chapter 03 §3 addition (the counter itself).
