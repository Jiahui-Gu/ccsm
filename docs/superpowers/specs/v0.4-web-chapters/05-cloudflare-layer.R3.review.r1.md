# Review of chapter 05: Cloudflare layer

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P0-1 (BLOCKER): `cloudflared` restart-exhaustion has no escalation — silent permanent failure

**Where**: chapter 05 §1 ("`cloudflared` lifecycle").
**Issue**: Spec says "Restart backoff: exponential, capped at 60s, max 10 attempts in 30 minutes; then surface error and stop trying." After exhaustion, what happens? "Stop trying" = remote access is dead until daemon restart. There's no retry-on-network-recovery (e.g. user changed wifi networks during the 30-min window), no auto-retry-after-N-hours, no notification escalation. Without explicit recovery, user learns about it only when they try to use web client and find it broken.
**Why this is P0**: this is the canonical "production down without notification" failure. User's flow: enable remote access → walk away → laptop sleeps → cloudflared dies during sleep → 10 retries fail in 30 min → stuck-down forever. User comes back next day expecting remote to work; it silently doesn't. There's no log surface to the desktop UI ("cloudflare.unreachable banner" mentioned but unclear if it's a daemon-restart-or-gone surface or persistent until manual fix).
**Suggested fix**: Make "stop trying" resumable: (a) on network-up event (Win has SENS, mac has SCNetworkReachability, Linux has NetworkManager DBus) auto-restart the cloudflared backoff cycle; (b) after exhaustion, fall back to a 5-minute steady-state retry instead of "stop forever"; (c) `cloudflare.unreachable` banner stays sticky on Electron desktop with "Retry now" button + last-error message + link to `cloudflared.log`. Document this in §1 explicitly.

### P1-1 (must-fix): JWKS fetch failure on first remote request blocks ingress with no fallback

**Where**: chapter 05 §4.
**Issue**: `createRemoteJWKSet` lazily fetches `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` on first JWT validate. If that endpoint is unreachable (Cloudflare DNS blip, daemon machine has no DNS yet at boot), every incoming web request rejects until JWKS fetch succeeds. 30s cooldown on miss means user sees minutes of failures.
**Why this is P1**: predictable boot-time scenario (daemon auto-starts at OS login per chapter 01 G6, before network fully up). User opens web tab during the JWKS-down window → permanent unauth'd → confused.
**Suggested fix**: Daemon at boot proactively fetches JWKS once (with retry 1s→30s exp-backoff), caches in-memory. Refuses to bind remote ingress until JWKS cached. If JWKS still unfetchable after 5 min, log + retry every 5 min in background; remote ingress stays unbound. Avoids the "rejected requests vs. closed listener" ambiguity for the client.

### P1-2 (must-fix): No idle-session eviction policy on the daemon

**Where**: chapter 05 §1 + cross-ref chapter 06 §5 + chapter 10 R5.
**Issue**: Auto-start daemon (chapter 01 G6) means daemon runs 24/7 across multiple-day intervals. PTY headless buffers (10k lines/session/scrollback) and per-subscriber fanout buffers (1 MiB) hold memory indefinitely for sessions the user hasn't touched in days. R5 in chapter 10 acknowledges the memory growth risk but provides no mitigation in v0.4. The spec is "monitor it in dogfood." That is observation, not policy.
**Why this is P1**: long-tail user (your own dogfood) reports "daemon RSS at 4 GB after 1 week" → already too late to design eviction; you'll have to hot-patch. Need at least the policy stated even if implementation is M4 deliverable.
**Suggested fix**: §1 (or new §) define idle-session eviction: session with zero subscribers AND no PTY output for 24h gets buffer-trimmed (scrollback drops to last 1k lines, fanout buffer freed). Session metadata (sid, cwd, name) persists in SQLite. On re-attach, reconstruct from DB + fresh PTY state (already-exited sessions show only the trimmed snapshot). Cross-ref chapter 06 §5.

### P1-3 (must-fix): `cloudflared` health-poll only via `--metrics` HTTP; not via tunnel-actually-routing

**Where**: chapter 05 §1 ("Health: poll `--metrics` HTTP endpoint every 30s; restart on 3 consecutive failures").
**Issue**: `cloudflared --metrics` reports cloudflared process health (alive, has token, opened control channel to CF edge). It does NOT confirm "the tunnel is actively routing requests from CF edge back to me." A degraded state — cloudflared connected but CF-side route is mis-mapped, or tunnel is throttled — passes the metrics check but fails real traffic.
**Why this is P1**: silent degradation. User reports "web client times out" but daemon shows `cloudflared healthy`. Wasted debugging cycles.
**Suggested fix**: Add an end-to-end health probe: every 60s, daemon makes an HTTPS GET to its own tunnel hostname (e.g. `GET https://<tunnel>/healthz` which routes back to the daemon's own /healthz handler over the round-trip path). 3 consecutive failures = log + flip surface to `cloudflare.unreachable` even if `cloudflared --metrics` is green. Cost is minimal (one outbound HTTPS/min).

### P2-1 (nice-to-have): No log strategy for `cloudflared.log` size cap / sampling

**Where**: chapter 05 §1.
**Issue**: "tee `cloudflared` stdout/stderr to `~/.ccsm/cloudflared.log` (rotated via pino-roll)" — but `cloudflared` at info level emits ~1 line per minute idle and bursts during reconnects. Pino-roll handles rotation but cap not stated. Also at log level "info" cloudflared can log every routed request → log spam at higher request rates.
**Suggested fix**: Specify cap (e.g. 50 MB × 5 files); recommend `--loglevel warn` after stable (info during M4 dogfood for diagnostics). One sentence.

### P2-2 (nice-to-have): No daemon metrics endpoint specified

**Where**: chapter 05 (entire chapter, also cross-ref chapter 02).
**Issue**: Daemon has `/healthz` (binary up/down) and v0.3's `/stats` on control socket. v0.4 adds the Connect surface, JWT validation, cloudflared sidecar, and remote ingress — none of which expose counts/rates/latencies for observability. To debug "is something slow", developer has only logs.
**Suggested fix**: Future-look note: v0.5 should expose `/metrics` Prometheus endpoint. v0.4 carryover: ensure `/stats` (control socket, supervisor RPC) gains counters for: connect-rpc requests/sec by method, JWT validation rejections/sec, cloudflared restart count, active stream count, fanout buffer total bytes. Cheap to add at this stage.

## Cross-file findings (if any)

- **Idle-session eviction (P1-2)** spans chapter 05, chapter 06 §5, chapter 10 R5. Single fixer.
- **`cloudflare.unreachable` banner persistence (P0-1)** spans chapter 04 §6 (banner taxonomy) + chapter 05 §1 + chapter 07 §2 (Cloudflare layer failures section). Single fixer.
