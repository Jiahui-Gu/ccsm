# Review of chapter 10: Risks

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): R5 (xterm-headless memory) trigger threshold is unactionable
**Where**: chapter 10 R5 ("Trigger: long-running daemon (>1 week) with 20+ sessions reports >2 GB resident memory.").
**Issue**: Triggering on "20+ sessions" is way past where the user notices. By that point the daemon has already swapped, slowed, possibly crashed. Mitigation is "v0.5+ scrollback eviction policy" which means v0.4 ships with a known unbounded growth. No instrumentation in v0.4 to **detect** the growth (no memory metric in pino log, no `/stats` extension).

Multi-client amplifier not even mentioned: each subscriber adds 1 MiB cap × N streams × M sessions to the daemon's working set.
**Why P1**: Risk register exists to drive instrumentation; this risk has no instrumentation.
**Suggested fix**:
1. Add to R5 mitigation: "v0.4 adds RSS sample to pino log every 5 min and to `/stats` endpoint. Dogfood gate post-M4 monitors trend over 7 days."
2. Lower trigger to "5+ sessions × 7 days resident memory >500 MB warrants investigation". Realistic for the single-user case.
3. Cross-link to chapter 06 R4 P0-2 (subscriber cap) as the related mitigation.

### P1-2 (must-fix): R10 (bundle size) gate threshold of 800 KB likely below actual day-1 bundle
**Where**: chapter 10 R10 ("CI lint: bundle-size check (`size-limit` package) on PRs touching `web/` or `src/`. Fail on >800 KB.").
**Issue**: See chapter 04 R4 P1-1 — realistic v0.4.0 first-load is 800-1100 KB before any new feature. The "fail at 800" gate either (a) trips on M3 first build and gets relaxed, eroding its value, or (b) blocks M3 unless aggressive code-splitting work is done that's NOT in the M3 spec.
**Why P1**: A gate that's destined to be relaxed is worse than no gate (false confidence + ritual exception).
**Suggested fix**: Measure first, set threshold at `actual + 15%`. Lock in M1 spike (per chapter 04 R4 P1-1).

### P1-3 (must-fix): No risk entry for "daemon CPU saturation under streaming load"
**Where**: chapter 10 (missing entry).
**Issue**: Node.js is single-threaded for JS execution. The daemon does:
- HTTP/2 frame parsing (libuv thread, OK).
- Connect interceptor stack per RPC (JS thread).
- Protobuf encode/decode for every PTY chunk + every keystroke (JS thread).
- xterm-headless ANSI parsing for every byte from `node-pty` (JS thread).
- pino log serialization (JS thread, blocking unless `pino.transport()`).
- JWT verify on every remote RPC (JS thread, ~1-2ms per).
- Snapshot serialization (JS thread, multi-MB CPU work).

Worst case: 5 sessions × hot PTY output + 2 web clients each subscribed + a snapshot RPC mid-flight = the JS event loop is saturated. New incoming RPCs back up; control socket /healthz also blocks (same event loop). Supervisor sees /healthz timeout → respawn → cascading failure (chapter 06 R4 P0-2).

This isn't theoretical: v0.3 already runs ANSI parsing in-process; v0.4 adds JWT + protobuf overhead atop the same loop.
**Why P1**: Risk register is the place to surface known performance ceilings. Currently silent.
**Suggested fix**: Add R5b "Daemon JS event loop saturation under multi-client streaming". Trigger: event loop lag (`perf_hooks.monitorEventLoopDelay`) p99 > 50ms. Mitigation: instrument event loop delay in v0.4 (cheap; built into Node); document worst-case session count; consider moving snapshot serialization to a worker_thread (defer to v0.5).

### P2-1 (nice-to-have): R13 installer-size delta understated
**Where**: chapter 10 R13 ("Installer was ~80 MB; will be ~100 MB. Negligible.").
**Issue**: `cloudflared` binary is ~30-40 MB on Win, similar on Mac/Linux. Bundling per-platform in a universal installer means the user downloads only their platform's `cloudflared`, but the per-platform installer grows by closer to 30-40 MB, not 20.
**Why P2**: Cosmetic; delta is small.
**Suggested fix**: Update number; non-blocking.

### P2-2 (nice-to-have): No risk entry for `cloudflared` itself consuming bandwidth/CPU when idle
**Where**: chapter 10 (missing).
**Issue**: `cloudflared` keeps an outbound TCP+TLS connection open, sends periodic heartbeats to Cloudflare edge, consumes ~30-50 MB resident memory. On a low-spec user box (older Win laptop), this is non-trivial. Not in any budget.
**Why P2**: Operational footprint, not a launch blocker.
**Suggested fix**: One-line entry. Cross-ref chapter 05 §8.

## Cross-file findings

**X-R4-I**: New risk R5b (event loop saturation) crosses chapter 06 (streaming), chapter 07 (failure modes), chapter 10 (this). Single fixer.
