# Review of chapter 10: Risks

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P1-1 (must-fix): R5 (xterm-headless memory) deferred to v0.5; v0.4 dogfood has no quantitative threshold

**Where**: chapter 10 R5.
**Issue**: R5 says "v0.4 dogfood (post-M4 7-day) monitors memory growth as part of the gate" — but no threshold defined ("if RSS exceeds X MB after Y days = fail gate"). Without it, "monitoring" is observation without action. Cross-ref chapter 05 P1-2 (idle-session eviction).
**Why this is P1**: makes the dogfood gate operationally vacuous. Either define "fails at X MB" or commit to the eviction policy (chapter 05 P1-2 fix).
**Suggested fix**: R5 add concrete threshold: "RSS > 1.5 GB after 7 days with typical usage (5-10 sessions, 1 web client open) = R5 triggered, ship v0.4 with eviction policy." If not adopted, R5 elevates to release-blocker on v0.5.

### P1-2 (must-fix): R6 (hostname leak) mitigation list missing the daemon-side detection

**Where**: chapter 10 R6.
**Issue**: Mitigation lists CF Access enforcement and documentation but no detection of "the hostname is being scanned." A leaked hostname plus a CVE in CF Access = user got pwned silently. R3 angle: at minimum the daemon should LOG unauthorized JWT attempts (rejected JWTs) for forensic value.
**Why this is P1**: post-incident forensics. Without rejection logs, "was I attacked?" is unanswerable.
**Suggested fix**: R6 mitigation add: "Daemon logs all rejected JWT attempts at `pino.warn({ event: 'jwt_rejected', sourceIp, reason, traceId })` — provides forensic trail." Cross-ref chapter 02 §8 + chapter 05 §4 (currently silent on rejection logging).

### P1-3 (must-fix): R7 (tab kept across upgrade) "MAY be deferred" creates real production risk

**Where**: chapter 10 R7.
**Issue**: "(M4 deliverable, MAY be deferred to v0.5 if scope tight.)" — the version-skew banner is the ONLY mechanism for the user to know they're on a stale build. Deferring it means stale-tab behavior (silent ignore of new fields) goes undetected indefinitely. User reports "feature missing"; you spend hours debugging before realizing they had a tab open across the upgrade.
**Why this is P1**: support burden compounding over release lifecycle. Adding it post-v0.4 means upgrades during the gap are unobservable.
**Suggested fix**: Promote the version-banner from MAY to MUST. It's a Ping RPC + 5-line UI banner. Negligible scope; outsized observability win.

### P2-1 (nice-to-have): R9 (`cloudflared` CVE) — no in-product version display

**Where**: chapter 10 R9.
**Issue**: Pinned version tracked in `daemon/scripts/cloudflared-version.txt` — but user can't see what version is running. After a CVE announcement, user cannot self-check. Daemon should expose `/stats` field `cloudflared_version`.
**Suggested fix**: One-liner: expose cloudflared version on the supervisor `/stats` RPC and surface in tray menu's About dialog.

### P2-2 (nice-to-have): No risk row for "telemetry blind spot" itself

**Where**: chapter 10 (entire chapter, missing entry).
**Issue**: The cumulative R3 finding across this review batch is "v0.4 has many failure modes that surface only via in-process logs the user must manually send." There's no risk entry calling this out as a class-level concern; without one, no design pressure to fix the per-component telemetry gaps.
**Suggested fix**: Add R16 (LOW or MEDIUM): "Diagnostic gap — most failure modes require user to manually export logs. Mitigation: bug-report kit (chapter 07 P2-3 fix), structured error reporting (chapter 04 P1-1 fix), version visibility (R7 P1-3 fix). Acknowledge this is a v0.4-shipped limitation; v0.5 should consider opt-in telemetry."

## Cross-file findings (if any)

- All P1s in this chapter mirror P1/P2 findings filed against chapters 04, 05, 06, 07. Coordinated fixer batch recommended.
