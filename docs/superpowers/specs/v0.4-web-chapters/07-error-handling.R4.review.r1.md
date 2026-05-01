# Review of chapter 07: Error handling and edge cases

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): Network drop reconnect semantics imply unbounded snapshot fetches over slow networks
**Where**: chapter 07 §3 ("Network drop mid-session", "If reconnect succeeds after >30 minutes: fanout buffer at the daemon may have rolled past `fromSeq`. Force re-snapshot.").
**Issue**: Spec says "lost-output is in the original PTY's history (visible in scrollback as part of the snapshot — xterm-headless preserves scrollback up to the configured limit, default 10k lines)". Combined with chapter 06 R4 P0-1, this means the snapshot is potentially multi-MB shipped over a network the user already had trouble reaching the daemon over. There is no mention of:
- Bandwidth-aware snapshot (downsize over slow links).
- Resumable snapshot fetch (HTTP/2 streams ARE resumable but Connect doesn't expose it).
- "Try seq replay first, fall back to snapshot" — the spec says force re-snapshot immediately.
**Why P1**: Reconnect over flaky network is the explicit failure mode the spec calls out; the recovery path isn't budgeted.
**Suggested fix**: Reference fix from chapter 06 R4 P0-1 (compression + cap). Additionally: spec a "if `fromSeq` is within 1 MB of the buffer-edge, ship a partial replay + delta-snapshot" hybrid, deferred to v0.5 if M4 scope is tight but documented as the path.

### P1-2 (must-fix): Backgrounded browser tab → drop-slowest → snapshot loop has no rate limit
**Where**: chapter 07 §3 ("Browser tab backgrounded for >100s") + chapter 06 §7 ("Web client implication: a backgrounded browser tab throttles its event loop. Slow event consumption → drop-slowest fires → snapshot on tab refocus.").
**Issue**: User backgrounds tab for 30 seconds, daemon emits PTY chunks faster than the throttled tab consumes → drop-slowest fires → tab gets "gap" marker → on refocus, fetches snapshot. Chrome aggressively throttles background tabs (~1 Hz timer cap as of 2024+). This means even a tab backgrounded for 10 seconds may trigger the drop. Repeated background/foreground (user toggling between tabs while working) → repeated multi-MB snapshot fetches.
**Why P1**: Tab-switching is the dominant user behavior on a laptop; design directly causes a perf cliff in the common case.
**Suggested fix**:
1. When `Page Visibility API` reports tab hidden, web bridge MUST proactively close the PTY stream (or pause it) to prevent the daemon from accumulating bytes for a slow consumer. On refocus: re-attach with `fromSeq`, replay if possible, snapshot as last resort.
2. Document this in §3 as "tab-backgrounded behavior" and in chapter 06 §7.

### P1-3 (must-fix): Daemon disk-full handler not budgeted under remote load
**Where**: chapter 07 §1 ("Daemon disk full ... v0.4: same banner reaches both Electron and web (it's in the renderer; both clients render it).").
**Issue**: When disk fills, what does the daemon do with in-flight RPCs? Spec says "SQLite write fails with `SQLITE_FULL`" but doesn't say:
- Are read RPCs (PTY snapshot, list sessions) still served? They should be — read path doesn't write.
- Does the JWKS log file rotation continue? `pino-roll` (per chapter 05 §1) needs disk for new log segments — if disk is full, log writes fail silently and we lose audit trail right when we most need it.
- Does pino logging itself fall over? On many transports, blocked writes propagate back; under remote load this could stall the event loop.
**Why P1**: Disk full is rare but the failure mode determines whether the user can recover gracefully or has to power-cycle.
**Suggested fix**:
1. Add a §1.5 sub-section: "When daemon detects ENOSPC: switch logger to in-memory ring buffer; serve read RPCs only; refuse PTY-input + DB writes with `resource_exhausted`; emit `storage.full` via a side-channel (control socket /healthz response field) so supervisor sees it without needing disk."
2. Test: drop-tank a disk-full scenario in a contract test.

### P2-1 (nice-to-have): JWT replay design accepts no-nonce but doesn't measure cookie hijack window
**Where**: chapter 07 §4 ("JWT replay (attacker steals JWT cookie)") and chapter 10 A5.
**Issue**: 24h JWT lifetime + no nonce store = a stolen cookie is good for up to 24h. Spec accepts this for single-user; that's fine, but no instrumentation: no log of unique-IP-per-JWT to detect "this token is being used from two countries simultaneously". Cheap to add, valuable signal.
**Why P2**: Audit/observability angle, not a launch blocker.
**Suggested fix**: pino info-log on every authenticated request: `{ jwt_jti, src_ip, ua, traceId }`. Aggregator (out of scope for daemon) can flag anomalies. ~10 LOC.

### P2-2 (nice-to-have): Concurrent rename on the same session has no perf bound
**Where**: chapter 07 §6 ("Both clients rename the same session simultaneously").
**Issue**: "Each `RenameSession(sessionId, title)` is unary and serialized at the daemon (per-sid serialization, v0.3 §sessionTitles). Last-write-wins." — per-sid serialization means a malicious or buggy client spamming RenameSession blocks all other RenameSession on that session. Bounded by daemon CPU but worth a per-client rate limit.
**Why P2**: Defensive depth.
**Suggested fix**: Per-(client, RPC) rate limiter at the JWT interceptor; return `resource_exhausted` past N RPCs/sec.

## Cross-file findings

**X-R4-G**: Disk-full handling spans chapters 05 (cloudflared logfile), 06 (PTY backpressure), 07 (this chapter). Single fixer.
