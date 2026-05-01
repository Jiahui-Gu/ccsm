# Review of chapter 05: Cloudflare layer (Tunnel + Access + JWT middleware)

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P0-1 (BLOCKER): Cloudflare Tunnel free tier may not actually be "unlimited bandwidth" for HTTP/2 streaming
**Where**: chapter 05 §7 ("Tunnel | Unlimited bandwidth, 1 free tunnel per account | 1 tunnel") and §8 ("Connection limits: Cloudflare doesn't publish hard caps for free Tunnel HTTP/2 stream concurrency, but anecdotally hundreds of concurrent streams are fine.").
**Issue**: The "unlimited bandwidth" claim is true for **WARP** in some configurations, but Cloudflare's Zero Trust Free tier has had documented soft-limits and TOS enforcement against "high-volume continuous streaming" use cases (Cloudflare TOS §2.8 historically; the current "abusive use" clause). A long-running PTY stream with multiple sessions × multi-client fanout × heartbeats every 90s, kept open 24/7 by a remote-access user, is exactly the kind of always-on traffic pattern that has previously triggered Cloudflare account warnings. v0.4's success criterion 2 ("author opens app from non-author network... no daemon restart required") presupposes this is reliable indefinitely.

The spec also asserts (§8) "anecdotally hundreds of concurrent streams are fine" with no citation and no spike. The success criterion is single-digit sessions, fine in isolation — but the design encourages the user to leave streams open across days, accumulating bandwidth.
**Why P0**: If Cloudflare flags or rate-limits the account post-launch, the entire web client stops working for the author. There is no fallback in the design (§4 R3 mitigation says "swap IdP" but that doesn't help a Tunnel ban). The "$0/month" claim in §7 may not survive contact with reality.
**Suggested fix**:
1. **Spike before M4**: stand up a real free-tier Tunnel and stream PTY output continuously for 7 days at typical session load. Measure aggregate bandwidth (PTY chunks) and confirm no Cloudflare warnings. Document in spike report.
2. Estimate a **per-month bandwidth ceiling** in §7: typical = `90s heartbeat × 5 streams × 50 bytes × 30 days` (negligible) + `peak PTY traffic` (compile output, large file cat, etc.). Without a number, "free tier" is aspirational.
3. Fallback plan documented in §7: if free tier proves untenable, switch to paid Tunnel ($5/month base) — design-wise zero work, but user expectations should know it's possible.
4. Cross-link to chapter 10 R3 — currently R3 only worries about Access tier, not Tunnel.

### P1-1 (must-fix): `cloudflared` health-poll backoff converges to silent failure
**Where**: chapter 05 §1 ("Restart backoff: exponential, capped at 60s, max 10 attempts in 30 minutes; then surface error and stop trying.").
**Issue**: After 10 attempts in 30 min the daemon **stops trying**. There is no scheduled retry after that. A user who experiences a transient Cloudflare edge issue (1h outage) and is away from their machine returns to find remote access permanently dead until they restart the daemon. From a "stable user-visible feature" angle this is a regression vs. local-only.

Additionally: polling `--metrics` endpoint every 30s for liveness is itself bandwidth + CPU on the daemon. Combined with PTY heartbeats, JWT validation, and pino log churn, the per-RPC cost stack starts to add up on resource-constrained machines (the user's old Win box).
**Why P1**: A retry policy that converges to permanent-off violates user expectation of "set it and forget it remote access". Performance angle: backoff loops without reset are a known anti-pattern (see ipc reconnect in v0.3 — same fix family).
**Suggested fix**:
1. After 10 attempts, fall back to a slow tick (1 attempt every 5 min, indefinitely). Reset to fast backoff on first success.
2. Halve the metrics-poll cadence to 60s; 30s is overkill for sidecar liveness.
3. Add a metric for `cloudflared_reconnect_seconds_total` exposed via daemon's existing logging.

### P1-2 (must-fix): JWT validation cost not budgeted; JWKS cache contention under load not addressed
**Where**: chapter 05 §4 (jose `createRemoteJWKSet` snippet + "30s cooldown on miss prevents JWKS-fetch storms under load.").
**Issue**: `jose.jwtVerify` against an RS256 / EdDSA cached JWKS is not free — typically 0.5-2 ms per call on Node 22 (RSA verify, base64url decode, header parse). For unary RPCs at modest rates (chapter 06 §3 estimates 7+ keystrokes/sec/session, plus settings polls, plus session-list polls) this is acceptable but warrants a budget. More importantly:
- The 30s cooldown applies to the **fetch**, not to the **verify path**. Under load, all incoming requests hit the same JWKS object simultaneously; jose's internal caching is per-key-id and uses lazy init — first request after a key rotation pays the JWKS HTTP fetch latency on its critical path. Spec doesn't say "JWKS warm-up at boot".
- No mention of `payload.exp` enforcement (jose does it by default but worth stating); no mention of `clockTolerance` (default 0 — if user's machine clock skews by 30s vs Cloudflare, every JWT fails). Clock skew on a Windows box is a real failure mode.
**Why P1**: Combination of (a) per-request 1-2ms cost not in any budget, (b) cold-start JWKS fetch on the request critical path, (c) no clock-skew tolerance — these are individually small, collectively enough to cause flaky auth in field conditions.
**Suggested fix**:
1. Pre-warm JWKS at daemon boot (call `jwks(...)` once with no token to seed the cache).
2. Set `clockTolerance: '30s'` in `jwtVerify` options.
3. Add a §4 perf note: "JWT verify cost target: ≤5 ms p99 over 1000 calls; measured in M4 dogfood gate."
4. Consider an in-process JWT result cache keyed by `<jwt-string>` → `<payload, expiry>` (TTL = remaining lifetime). Same-cookie-many-RPCs is the dominant case; one verify per cookie is enough.

### P1-3 (must-fix): TCP listener bound on `127.0.0.1:7878` shared between dev mode and prod cloudflared collides
**Where**: chapter 05 §5 table row ("Data socket (remote) | TCP `127.0.0.1:7878` (only when remote enabled) | Cloudflare Access JWT") + chapter 04 §5 ("Vite dev server uses a custom middleware to proxy `/ccsm.v1.*` paths to the local daemon's HTTP/2 listener... daemon also binds an explicit TCP listener `127.0.0.1:7878` for browser access").
**Issue**: Same port number used in dev mode and prod cloudflared mode. A developer running daemon in dev mode AND having remote-access enabled will crash on `EADDRINUSE`. More subtly: chapter 04 §5 says the dev TCP listener has **no JWT validation**. If the developer toggles "remote access on" while dev TCP is up, what happens? Spec doesn't say which listener wins the port; if dev wins, cloudflared proxies to an unauth'd listener, fronted only by Cloudflare Access. JWT bypass survives → fine in this case, but accidental.

Performance angle: if the dev path uses HTTP/1.1 → HTTP/2 shim and cloudflared expects HTTP/2 end-to-end, the shim will silently degrade prod performance.
**Why P1**: Mode confusion + port collision + auth path diverges. Spec must pick distinct ports OR enforce mutual exclusion at startup.
**Suggested fix**:
1. Different ports: dev = `127.0.0.1:7878`, prod = `127.0.0.1:7879` (or whatever).
2. Daemon refuses to start prod TCP listener if `CCSM_DAEMON_DEV_TCP` is set (or vice versa).
3. Document in §5 which listener cloudflared targets.

### P2-1 (nice-to-have): Cloudflare HTTP/2 protocol forcing not strictly required, may add latency
**Where**: chapter 05 §8 ("HTTP/2 over Tunnel: ... We force HTTP/2 by setting `--protocol http2` in `cloudflared` args.").
**Issue**: `cloudflared` actually defaults to QUIC (HTTP/3) for outbound where supported; forcing HTTP/2 may add a TCP handshake on each cold connection where QUIC could 0-RTT. Not a blocker but the design should note WHY HTTP/2 specifically (server-streaming inside HTTP/2 tunnel works; should test inside QUIC equivalent).
**Why P2**: Optimization, not a release blocker.
**Suggested fix**: Spike `--protocol auto` (let cloudflared pick QUIC) during M4 and compare cold-start latency. If QUIC works for streaming, drop the `--protocol http2` lock.

## Cross-file findings

**X-R4-D**: TCP-listener port + JWT bypass policy spans chapters 04 §5 and 05 §5; needs single fixer to keep them aligned.
