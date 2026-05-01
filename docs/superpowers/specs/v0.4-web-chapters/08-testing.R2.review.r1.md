# Review of chapter 08: Testing

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): JWT mocking in L4 web e2e — test JWKS mechanism opens a permanent backdoor if env var leaks
**Where**: chapter 08 §5, "test-mode JWT signed by a local test JWKS (daemon configurable to use a test JWKS via `CCSM_DAEMON_TEST_JWKS_URL` env var). Test JWKS has known keys; test JWTs with arbitrary claims can be minted."
**Issue**: Same threat shape as the dev TCP listener (chapter 04 R2 P0-1). An env var that swaps out the JWKS URL is a textbook auth bypass: any user/attacker who can set `CCSM_DAEMON_TEST_JWKS_URL` (e.g. via shell rc files, CI environment leak, social engineering, malware modifying user env) replaces real Cloudflare JWKS with attacker-controlled keys, mints arbitrary JWTs, and bypasses Access entirely.

The chapter doesn't say:
1. The env var is gated on production builds (must be impossible in shipped binary).
2. The env var is logged at startup as a `pino.warn({test_jwks: true})` so attacker can't silently flip it.
3. The test JWKS URL is restricted to localhost/file URI to prevent remote-controlled JWKS.

**Why this is P1**: same class of footgun as dev TCP listener; one env var = full remote auth bypass.
**Suggested fix**: Lock in chapter 08 §5:
1. `CCSM_DAEMON_TEST_JWKS_URL` MUST be unrecognized in production builds (compile-time gate; env var read returns undefined). Daemon refuses to start if production-build sees this env var set (paranoid defense).
2. Test JWKS URL MUST be restricted to `file://` or `http://127.0.0.1:*` schemes; reject any other scheme.
3. On startup with test-mode active: `pino.warn({ test_mode: 'jwks_override' })` and a startup banner in dev console.
4. Test fixture sets the env var per-test, unsets after — never relies on global.
5. Reference chapter 04 §5 production-gate mechanism for symmetry.

### P1-2 (must-fix): Cloudflare smoke (L6) uses a long-lived service token — secret handling not specified
**Where**: chapter 08 §7, "real CF Access cookie (CI service-token auth bypasses GitHub OAuth)"
**Issue**: Service tokens in CI are credentials with the same effective access as the user. Spec doesn't say:
1. How is the service token stored? (GitHub Secret, Cloudflare-issued, rotation cadence?)
2. Is the service token scoped to the CI-only Access app (separate from the author's daemon), or does it grant the same permissions?
3. Service token logging discipline (don't log to CI artifacts).
4. Rotation policy (90-day rotation? annual?).

**Why this is P1**: leaked service token = perpetual backdoor to the CI-tunnel, which if mis-scoped also accesses the author's daemon.
**Suggested fix**:
1. Service token MUST be scoped to a separate Cloudflare Access application protecting ONLY the CI tunnel (different AUD from author's production tunnel).
2. Stored in GitHub Secrets, masked in logs, never echoed.
3. Rotation: every 90 days; calendar reminder in chapter 11 references.
4. Lockdown: CI workflow `cf-smoke.yml` declares `permissions: read-all` and uses fine-grained PAT.

### P2-1 (nice-to-have): No security regression test in CI
**Where**: chapter 08 §1-9
**Issue**: No mention of static-analysis security checks (semgrep, npm audit, snyk, socket.dev) on PRs. v0.4 introduces ~5 new dependencies (`@connectrpc/*`, `jose`, `@bufbuild/*`) and bundles `cloudflared` — supply-chain hygiene merits CI integration.
**Why this is P2**: hardening, not blocking.
**Suggested fix**: Add CI job `security-audit.yml`: `npm audit --production --audit-level=high` on PRs touching `package.json`/`package-lock.json`. Optional `semgrep --config=p/typescript --config=p/security-audit` weekly.

### P2-2 (nice-to-have): No fuzz test for proto decoder
**Where**: chapter 08 §3
**Issue**: Daemon parses Connect/HTTP/2/protobuf from untrusted (post-JWT) input. A protobuf decoder bug = potential RCE in daemon. Generated code is mature, but custom interceptors (deadline, migration-gate, JWT) parsing untrusted headers are bespoke. A small fuzz suite would be valuable.
**Why this is P2**: defense-in-depth; bespoke header parsing is the highest-value fuzz target.
**Suggested fix**: Add a vitest fuzz/property-test for: deadline header parsing (negative numbers, NaN, MAX_SAFE_INTEGER, non-numeric, very long), trace-id header parsing (non-ULID), Cf-Access-Jwt-Assertion (oversized, malformed, multiple values).

## Cross-file findings

P1-1 (test JWKS env var) is the same class of issue as chapter 04 R2 P0-1 (dev TCP listener). Both are "env var = security boundary toggle". A single design rule covers both: "any env var that loosens security MUST be (a) absent in production builds, (b) log-warned at startup, (c) restricted in scope to localhost." Recommend a meta-section in chapter 02 or chapter 09 listing all such env vars with their gates.
