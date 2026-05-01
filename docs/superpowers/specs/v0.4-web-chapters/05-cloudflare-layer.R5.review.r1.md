# Review of chapter 05: Cloudflare layer

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): JWT validation test matrix is under-specified for a security-critical surface
**Where**: chapter 05 §4 + chapter 08 §3 / §5 / §7
**Issue**: chapter 08 §5 lists `web-auth-bypass-blocked` (strip JWT, expect 401) and §7 lists a real-CF nightly. Missing from any layer: explicit unit/contract tests for the JWT failure modes that aren't "no header" — wrong audience, wrong issuer, expired token, unsigned (`alg: none`), wrong key (signed with attacker's key), missing `kid` in header, JWKS endpoint unreachable, JWKS rotation race (token signed with old key just rotated out). Each is a known JWT-security pitfall and `jose` doesn't catch them automatically without correct configuration.
**Why this is P0**: the JWT interceptor IS the remote auth boundary. A misconfigured `jwtVerify` (e.g. forgot to pass `audience` option, accepts any `aud`) would silently let any signed-by-CF JWT in — including ones for OTHER Cloudflare Access apps the attacker happens to be allowed on. This class of bug is invisible without explicit negative tests. Author's own "open topic 5" (mock JWT vs real CF) flags this — reviewer agrees: mock-only per PR + nightly-only real-CF means the failure-mode matrix MUST be exhaustively unit-tested with the mock.
**Suggested fix**: chapter 08 §3 adds a "JWT validation matrix" contract-test list with explicit cases: wrong-aud, wrong-iss, expired, alg=none, missing-kid, signed-with-wrong-key, JWKS-unreachable (assert fail-closed), JWKS-rotation-mid-request. Each case specifies expected `Code.Unauthenticated` + a specific log-line tag.

### P1-1 (must-fix): `cloudflared` health-check + restart logic has no specified test
**Where**: chapter 05 §1 — "Health: poll `--metrics` HTTP endpoint every 30s; restart on 3 consecutive failures."
**Issue**: the health-check + 3-strikes + exp-backoff + 10-attempts-in-30min + give-up state machine has 5 timers and 3 thresholds. No specified test, no injectable clock. This is the surface that decides whether remote access auto-recovers. A regression that flips "3 consecutive" to "any failure" causes restart storms; a regression that flips "exponential cap 60s" to "no cap" causes infinite retry hangs.
**Why P1**: state machines without injectable clocks are flake mines; this one is operationally critical and not covered by chapter 08 anywhere.
**Suggested fix**: chapter 05 §1 adds a "Testability" subsection specifying: cloudflared spawn is wrapped in a factory injectable as `spawnCloudflared = childProcess.spawn` so tests can substitute a fake; health-poll uses an injectable clock; chapter 08 §3 contract tests cover the state-machine boundaries (1 fail = no restart; 3 fail = restart; 10 attempts in 30min = give up + banner).

### P1-2 (must-fix): Local cloudflared dev/test setup not addressed
**Where**: chapter 05 §1 + §6
**Issue**: spec assumes the daemon-supervised cloudflared. For local development (and any local-machine integration testing), can a developer run cloudflared without a real Cloudflare account? Cloudflare's "TryCloudflare" mode (`cloudflared tunnel --url` without `--token`) creates an ephemeral tunnel without account, but spec only documents the token-bound flow. Engineers without their own CF account (hires, contractors, CI) can't smoke-test the tunnel layer locally.
**Why P1**: blocks contributor onboarding to the cloudflared code path; without a no-account path, all changes to chapter 05 logic land untested locally and only burn the nightly L6.
**Suggested fix**: chapter 05 §1 adds "Local development without a Cloudflare account: `cloudflared tunnel --url http://127.0.0.1:7878` (TryCloudflare ephemeral mode) gives a temporary `*.trycloudflare.com` hostname with no Access protection — useful for tunnel-pipe smoke tests, NOT for JWT path." Chapter 08 §3 mentions this as a fallback for contract tests of the spawn/supervise logic.

### P1-3 (must-fix): JWT "open topic 5" (mock per PR, real CF nightly) creates a delayed bug surface
**Where**: chapter 08 §5 (mock) + §7 (nightly real CF)
**Issue**: the chosen split — every PR uses mock JWKS, real CF only nightly — means a bug in real-CF interaction (e.g. CF changes JWT claim shape, our code parses claim that's wrong format) only surfaces 12-24h after the merge. With v0.4's milestone cadence (M4 is 30h), a single bad nightly can blow days off the schedule. Author flags this in the open topic; reviewer-side recommendation: at minimum ONE per-PR test using a recorded real-CF JWT (captured once, replayed) so the parser is exercised against real data on every PR; rotation handled by re-recording quarterly.
**Why P1**: the mock JWKS validates signature but not claim shape; recorded real-CF JWT validates parser end-to-end without requiring live CF.
**Suggested fix**: chapter 08 §5 adds `web-jwt-realshape` case using a checked-in recorded JWT (with sensitive claims redacted/regenerated). §7 stays as the live-network smoke.

### P2-1 (nice-to-have): JWKS cooldown semantics testable but not specified
**Where**: chapter 05 §4 — "30s cooldown on miss prevents JWKS-fetch storms"
**Issue**: the cooldown is testable (mock JWKS endpoint, send N requests, assert ≤1 fetch in 30s) but no entry in the test plan.
**Why P2**: defense-in-depth; not a load-bearing failure mode for v0.4 single-user.
**Suggested fix**: chapter 08 §3 adds a one-liner test entry.

### P2-2 (nice-to-have): `cloudflared` binary supply-chain check is testable
**Where**: chapter 05 §1 + chapter 10 R9
**Issue**: pinned version stored in `daemon/scripts/cloudflared-version.txt`. CI could verify the bundled binary's `cloudflared --version` matches the file at build time. Trivial and catches "we updated the file but forgot to swap the binary" or vice versa.
**Why P2**: low-likelihood, low-immediacy.
**Suggested fix**: chapter 08 §9 (or chapter 09 M4 deliverable list) adds a build-step check.

## Cross-file findings

- **JWT validation matrix** (P0-1) primarily lives in chapter 05 §4 but the test entries belong in chapter 08 §3 — single fixer for both.
- **JWT real-shape test** (P1-3) cross-cuts chapter 05 §4 + chapter 08 §5/§7.
- **Dev-without-CF-account flow** (P1-2) cross-cuts chapter 05 §1/§6 + chapter 04 §5 (local dev story) + chapter 08 §3.
