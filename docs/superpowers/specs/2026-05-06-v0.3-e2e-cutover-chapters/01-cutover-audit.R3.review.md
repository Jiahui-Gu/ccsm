# Review of chapter 01: Cutover audit

Reviewer: R3 (reliability / observability)
Round: r1

## Findings

### P1-1 (must-fix): HP-12 leaked-daemon escape clause has no observability handle

**Where**: chapter 01, HP-12 "electron/lifecycle/appLifecycle.ts daemon shutdown" (lines 234-242).
**Issue**: HP-12 is currently `KEEP unless audit during repair shows leaked daemon processes between cases — in which case promote to FIX in chapter 04 §4`. But no fixer (or chapter 04 §4 today) defines HOW one would detect the leak: there is no port-uniqueness check, no `pgrep ccsmd`, no harness-runner per-case daemon-pid log. The escape clause therefore can't fire.
**Why this is P1**: a leaked daemon between cases is the most common reliability footgun in e2e harnesses (the next case binds a fresh port, but the stale daemon's open file descriptors / SQLite locks may corrupt shared state under `~/Library/Application Support/ccsm/...`). Without a detection hook in chapter 04, P0/P1 promotion will only happen post-incident. Should be a v0.3 reliability gate, not a v0.4 problem.
**Suggested fix**: chapter 04 §2 (probe-utils refresh) or chapter 04 new §5 must add: harness-runner MUST log the daemon PID at spawn and assert that PID is gone (`process.kill(pid, 0)` throws ESRCH) within 5s after the case's electron app quits. If still alive, fail the case with `daemon_leaked_pid=<n>`. Cross-reference in HP-12.

### P1-2 (must-fix): HP-3 audit acknowledges 5s budget elapses but does not list cold-launch budget targets

**Where**: chapter 01, HP-3 "daemon port readiness for preload bridges" §"Hypothesis" (lines 99-104).
**Issue**: The hypothesis states "cold electron launches under e2e take longer than 5s". Chapter 03 §3 jumps straight to "30s watchdog" without showing measurements that justify either the current 5s budget being too tight or 30s being plausibly enough. Author Q2 in their prompt to R3 is exactly this gap. There is no measured baseline for: (a) `app.whenReady` time, (b) `child_process.spawn(node)` time, (c) port-bind time, (d) first `PORT=<n>` flush. Without these, Option C's "cold app launch grows by daemon-boot time" claim (chapter 03 §3 cons) is unverifiable.
**Why this is P1**: if real cold-start is 8s on Windows CI (plausible — node child + npm-install-warm cache), Option C makes the visible "click → window" delay user-visible, NOT "sub-second" as chapter 03 §3 claims. Reliability surface: the e2e gate could become flaky on slow CI runners, OR the user UX regresses silently in production.
**Suggested fix**: chapter 01 add a §"Open audit questions" Q5: "What is the measured p50/p95 cold-spawn budget on (a) Windows dev box, (b) macOS dev box, (c) Linux GH runner, broken down into the four steps above? Required before Option C is committed." Block PR-3 dispatch until the budget table lands. If p95 > 2s on any platform, force Option B (pre-resolved cache via IPC event) instead.

### P2-1 (nice-to-have): cross-cutting hypotheses §"hydration-ordering thread" omits failure-mode for `loadState` HTTP rejection

**Where**: chapter 01, "Cross-cutting hypotheses" (lines 250-260).
**Issue**: The thread says "fixing hydration likely closes S3/S4/S6/S7" but the failure path when the daemon is up yet `/api/data/get` returns 500 (corrupted DB, ENOSPC) is not in scope of any HP. Renderer would fall back to defaults silently if `loadState` resolves null, but if it rejects, the catch in `src/stores/persist.ts` (currently undocumented) decides UX.
**Why this is P2**: low-incidence in normal operation; matters mostly for crash-recovery edge.
**Suggested fix**: add a minor HP entry HP-2b "loadState rejection path" deferring to chapter 02 §3 to spec the renderer behaviour on rejection (toast vs silent default). Or document explicitly that "rejection is caller's responsibility per chapter 02".

## Cross-file findings

- P1-1 detection mechanism is owned by chapter 04, but the HP that triggers it lives in chapter 01. Single fixer should sync both.
- P1-2 budget measurement is the prerequisite for chapter 03 §3 Option C/B/A choice; coordinated edit between chapters 01 and 03 needed.
