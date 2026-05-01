# Review of chapter 02: Protocol (Connect + Protobuf + buf)

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): Dropping HMAC from data socket leaves no defense-in-depth against same-user local processes
**Where**: chapter 02 §8, "Why drop HMAC for the local socket"
**Issue**: v0.3's local-socket trust boundary was peer-cred + chmod 0700 + named-pipe ACL + HMAC handshake (with boot-nonce). v0.4 drops HMAC, leaving peer-cred as the ONLY check. Peer-cred verifies "same user, same machine" but does not distinguish between *legitimate* same-user processes (Electron preload) and *malicious* same-user processes (a compromised dev tool, a curl-from-shell, a node REPL launched by a phishing-installed CLI, an attacker who got code-exec via a vulnerable VS Code extension running under the same user). Once any same-user process can connect, the entire daemon RPC surface (PTY input/output, SQLite, settings, secrets including the future `cloudflare_tunnel_token`) is reachable. HMAC + boot-nonce was the second line: it required the connecting process to know a per-boot secret, which a generic same-user attacker would not have absent reading the daemon's process memory or filesystem-leaked secret.

The chapter's justification ("HMAC was always belt-and-suspenders on top of peer-cred") understates what HMAC provided: it gated knowledge of a fresh boot secret. Defense-in-depth against same-user-local-malware is not theatre — it's the standard threat model for desktop apps that hold credentials (1Password, SSH agent, GitHub CLI all assume same-user processes can be hostile and harden accordingly).

**Why this is P1**: post-v0.4 the daemon will hold (a) the OS-keychain-encrypted Cloudflare tunnel token, (b) the user's GitHub OAuth-derived JWT-validated identity, (c) live PTY streams which may include user-typed credentials, (d) SDK Claude API keys. Any same-user local process getting RPC access can ex-filtrate all of the above. This is a real attack surface; "save 500 LOC" is not a sufficient counterweight.
**Suggested fix**: Either (a) keep HMAC handshake on the data socket Connect server (re-implement as a Connect interceptor that fails-closed if missing/invalid), OR (b) explicitly document in chapter 02 §8 + chapter 10 R-section the threat model being accepted ("v0.4 trusts every same-user process") and add it to chapter 10 §4 "Risks the design explicitly accepts" with a target version for re-introducing HMAC. Recommend (a). If (b), name the threat: "same-user local process can issue arbitrary RPCs including reading PTY output streams and tunnel token via settings RPCs."

### P1-2 (must-fix): JWT validation pins are incomplete — alg, kid, clock skew, replay window
**Where**: chapter 02 §8 (JWT carryover), chapter 05 §4 (JWT interceptor implementation)
**Issue**: The `jwtVerify(token, jwks, { issuer, audience })` call shown in chapter 05 §4 leaves several validation knobs at library defaults that should be explicit security policy:
1. **Algorithm pinning**: jose accepts any signing alg in the JWKS by default. Cloudflare uses RS256/ES256; if an attacker can inject a key into JWKS (e.g. via a CF-side compromise), they could potentially use a weaker alg. Spec MUST pin `algorithms: ['RS256']` (or whatever Cloudflare guarantees) in `jwtVerify` options.
2. **Clock skew**: default `clockTolerance` is 0 — a 1-second clock drift between daemon and Cloudflare = false-rejects. Document the chosen tolerance (e.g. 30s) so it's not invisibly default-changed.
3. **`exp` and `iat` enforcement**: jose checks `exp` by default but not `iat` upper-bound (token issued in the future = clock-skew attack indicator). Spec should state the policy.
4. **Audience binding**: `audience: AUDIENCE` is shown but the AUD value is `<application-aud-tag>` placeholder. Spec must require this be the *tunnel-specific* AUD (one AUD per Access app), not a wildcard. A cross-app AUD reuse would let an attacker who got a JWT for a different Cloudflare Access app on the same team validate against this daemon.
5. **JWKS refresh DoS**: chapter 02/05 says "30s cooldown on miss prevents JWKS-fetch storms" — but does jose's `cooldownDuration` mean "cap the rate of refresh attempts" or "cap the rate of validation attempts during outage"? Cite the jose semantics; if validation hangs waiting for JWKS, that's a DoS surface (attacker submits requests with `kid` not in cache → daemon hammers JWKS endpoint → CF rate-limits → all auth fails).

**Why this is P1**: JWT validation is THE auth boundary for remote ingress. Spec shows pseudocode but doesn't lock the policy fields that matter. Worker implementing this will pick library defaults; library defaults change between versions.
**Suggested fix**: Add a §4.X subsection in chapter 05 (or extend §8 in chapter 02) with explicit JWT validation policy:
- `algorithms: ['RS256']` (verify Cloudflare's actual alg first)
- `clockTolerance: 30` (seconds)
- `requiredClaims: ['exp', 'iat', 'aud', 'iss', 'sub']`
- AUD value MUST be unique per Access application (not shared across user's other Cloudflare apps)
- JWKS fetch timeout: 5s, fail-closed on timeout (do not allow request through)
- JWKS unknown-kid: refresh once, then fail-closed (don't retry-storm)

## Cross-file findings

See chapter 05 review for the JWT/AUD/keychain-secret concerns that span both chapters.
