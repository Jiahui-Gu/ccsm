# Review of chapter 08: Testing

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P1-1 (must-fix): Cloudflare smoke "nightly only" = real-CF flakes only caught nightly

**Where**: chapter 08 §7 (L6 Cloudflare integration smoke).
**Issue**: Author's open question (relayed in this review's prompt) explicitly flags this. R3 angle: nightly-only signal means a regression introduced Monday morning isn't caught until Tuesday morning. If a v0.4-rc tag is cut Monday afternoon, real-CF regression ships. The L4 web e2e uses mocked JWKS so it cannot catch (a) real CF Access policy misconfigurations, (b) JWT format changes from CF, (c) JWKS endpoint URL drift, (d) tunnel routing latency regressions, (e) heartbeat → Cloudflare-100s-idle timing in real conditions.
**Why this is P1**: release-blocker class of bug surfaces post-release. v0.4 reliability hinges on CF integration; the test that exercises it runs <10% of CI cycles.
**Suggested fix**: Compromise mid-point: keep L6 nightly + ALSO run L6 on PRs touching `daemon/src/connect/jwt-interceptor.ts`, `cloudflared` spawn code, or `daemon/src/sockets/runtime-root.ts` (the small surface where real-CF differs from mock). Trade a couple minutes on those PRs for tight feedback. Document the path-trigger.

### P1-2 (must-fix): No test for cloudflared lifecycle (spawn, restart, exhaustion)

**Where**: chapter 08 (no entry).
**Issue**: Chapter 05 §1 specifies cloudflared spawn/supervise/restart/exhaustion behavior. Chapter 07 P0-1 (in this review batch) flags missing recovery on exhaustion. No L2/L3 test exercises this cycle. Bug in supervise logic ships untested.
**Why this is P1**: the cloudflared lifecycle code is novel in v0.4 (no v0.3 carryover). Untested novel = high regression risk.
**Suggested fix**: Add L2 daemon unit test: mock `child_process.spawn` for cloudflared, simulate process-exit at various lifecycle points, assert restart backoff matches spec, exhaustion surfaces banner, recovery on network-up event (per chapter 05 P0-1 fix) actually retries.

### P1-3 (must-fix): No test for daemon-restart-during-active-stream (full reconnect cycle)

**Where**: chapter 08 §6 (multi-client) + §5 (web reconnect).
**Issue**: `web-reconnect` case is "Disconnect daemon mid-stream, reconnect, assert seq-replay continues." That tests network drop. It doesn't test daemon CRASH (boot_nonce change → force snapshot, chapter 06 §6). Different code path, different failure modes.
**Why this is P1**: chapter 06 §6 force-snapshot path is mentioned but only proven by manual reasoning. Production: daemon SIGKILL → respawn → all clients should re-snapshot cleanly. Untested.
**Suggested fix**: Add L5 case `multi-client-daemon-crash`: spawn daemon, attach two clients, send some PTY output, kill -9 daemon, supervisor respawns, assert both clients reconnect with fresh snapshot AND no data corruption.

### P2-1 (nice-to-have): `pages-preview.yml` failure mode unspecified

**Where**: chapter 08 §9 (CI matrix table).
**Issue**: Cloudflare-managed Pages preview is in the CI matrix but its failure mode isn't documented. If Pages build fails, does it block PR merge? Just notify? Depends on Cloudflare's GitHub status API integration setup.
**Suggested fix**: One sentence: "Pages preview failure surfaces as a non-blocking GitHub check; PR can merge anyway (rationale: Pages env can be transient)."

### P2-2 (nice-to-have): No test budget for log-spam regression

**Where**: chapter 08 (entire chapter).
**Issue**: Heartbeats every 60-90s × N streams + per-keystroke unary input = high request rate. If logging accidentally goes from `debug` to `info` on a hot path, daemon log fills disk in days. No automated check.
**Suggested fix**: Add an L2 test: run a hot session for ~10s, assert daemon log line-count below threshold (e.g. <100 lines for 10s of normal traffic).

### P2-3 (nice-to-have): Migration-window CI tolerance has no end-condition test

**Where**: chapter 08 §9 (migration-window CI tolerance).
**Issue**: "Window opens at M1 start, closes at M2 start" — but no automated check enforces re-enabling. Could leave workflows disabled past intended window.
**Suggested fix**: Add a CI smoke that checks workflow file's `if: false` is gone after a certain commit/tag.

## Cross-file findings (if any)

- **Daemon-restart-during-stream test (P1-3)** validates chapter 06 §6 + chapter 07 §1 + chapter 05 §1. Single fixer.
