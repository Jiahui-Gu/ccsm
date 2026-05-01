# Review of chapter 05: Cloudflare layer

Reviewer: R2 (security)
Round: 1

## Findings

### P0-1 (BLOCKER): Tunnel token & Cloudflare config secrets — encryption-at-rest scheme is hand-waved
**Where**: chapter 05 §1, "the resulting tunnel token (a long string) is stored in the daemon's SQLite (`settings.cloudflare_tunnel_token`, encrypted at rest with the OS keychain — Win Credential Manager / macOS Keychain / Linux `libsecret`)"
**Issue**: "Encrypted at rest with the OS keychain" is a single sentence that hides several decisions that determine whether the scheme is actually secure:
1. **Where does the encryption KEY live?** If "encrypted with OS keychain" means "the secret value IS stored IN the keychain", then SQLite stores nothing and the keychain is the single source — fine, but then "stored in SQLite encrypted" is wrong wording. If "encrypted with a key from the keychain", then the key lives in keychain and the ciphertext lives in SQLite — also fine, but the spec doesn't say which.
2. **Win Credential Manager** has a per-user scope; any process running as the user can read it. Same as the local-process trust boundary issue (chapter 02 R2 review). Stating the threat model: "any same-user process can recover the token" is the truth and should be in the spec.
3. **Linux `libsecret`** requires a running secret-service (gnome-keyring or kwallet); on a headless Linux box (where the daemon may genuinely run, despite chapter 01 N5 saying headless is out of scope, M4 wants auto-start which IS effectively headless until login), `libsecret` is unavailable. Spec must specify fallback (refuse to enable remote? store plaintext with a warning? derive key from machine-id?).
4. **Tunnel token is a long-lived credential** that grants ANY HTTPS endpoint behind that tunnel. If exfiltrated, an attacker spawns their own `cloudflared` with the token and can route the user's tunnel hostname to the attacker's server (DoS / phishing the user's own JWT login flow).
5. **Cloudflare team name + AUD** stored alongside the token — these are not secrets, but together with the token enable full impersonation of the daemon's auth endpoint.
6. **Setup wizard 3-step copy/paste** (chapter 05 §6 + author's open topic 4): user pastes the token into an Electron Settings textarea. The token transits: clipboard → renderer → preload → IPC to main → daemon. Each hop is a potential leak (clipboard managers log clipboard, renderer crash dump may contain the textarea value, IPC log instrumentation may capture it). Spec must say: token MUST NOT be logged anywhere, MUST be moved through a single secret-typed channel, MUST be cleared from any DOM / store immediately after persist.

**Why this is P0**: tunnel token compromise = remote attacker can re-route the user's tunnel hostname to attacker-controlled infrastructure, conduct credential phishing for the user's GitHub OAuth, and the user has no easy way to detect this. Encryption-at-rest is the *only* protection if the SQLite file is read by a malicious process. The scheme has to be locked, not hand-waved.
**Suggested fix**: Add a §1.X subsection with concrete crypto:
1. **Storage scheme (lock)**: tunnel token + CF AUD stored ONLY in OS keychain (via `keytar` or `node-keytar` — note: keytar is unmaintained; verify alternative). SQLite contains a non-secret pointer `cloudflare_token_keyring_id = "ccsm.tunnel.token"`. Daemon fetches from keychain on demand; never persists plaintext to SQLite or disk.
2. **Linux fallback**: if `libsecret` unavailable, daemon refuses to enable remote access; surfaces "remote access requires a secret-service (gnome-keyring/kwallet)" error. Document for headless Linux: user installs `gnome-keyring` and unlocks via `dbus-launch`, or accepts that remote access requires a desktop session. NO plaintext fallback.
3. **In-memory handling**: token kept in a `SecureBuffer` (zeroed on use); never written to log, never serialized to JSON, RPC handler returns an `existence boolean` not the token value.
4. **Setup wizard**: Settings UI uses `<input type="password">` with `autocomplete="off"`, on submit the value is sent via a dedicated Connect RPC (not the generic settings RPC) that immediately stores to keychain and zeroes the in-memory copy. Renderer never re-reads the value.
5. **Logging**: pino redaction config explicitly redacts any field name matching `/(token|secret|jwt|aud|password)/i`. Locked in chapter 05.

### P0-2 (BLOCKER): Single Cloudflare Access policy "include emails" + GitHub OAuth — single-factor, high-blast-radius
**Where**: chapter 05 §3, "include: emails: ['<author's GitHub email>']" + "auto_redirect_to_identity: true"
**Issue**: The auth boundary is "anyone with a GitHub session for `<author's email>`". GitHub session compromise = full daemon access (PTY input/output, ability to spawn arbitrary commands via PTY). GitHub session compromise paths:
1. Stolen GitHub OAuth refresh token (browser cookie theft via XSS/phishing).
2. GitHub account password compromise (if user has weak/reused).
3. GitHub session hijack from a compromised device.

The Access policy uses ONLY email-match. There is no second factor (no `require: device_posture`, no `require: country_code`, no Cloudflare Access service-token MFA). Cloudflare Access supports `require: mfa: { provider: github, type: totp }` etc. — spec doesn't require it.

Additionally, spec says (chapter 07 §4 A5) "JWT replay not prevented (no nonce/jti store)". Combined with single-factor email check, the attack surface is: phish the user's GitHub OAuth, get JWT, replay or use directly, persistent access until JWT expires (24h, chapter 05 §3) or user revokes Cloudflare session.

**Why this is P0**: This is the v0.4 product's primary remote auth boundary. "Single user, GitHub email" is treated as sufficient, but the attacker payoff is full RCE on the user's primary workstation (PTY = arbitrary shell). The bar must be higher than "user logged into GitHub".
**Suggested fix**: 
1. **REQUIRE second factor** in Access policy: `require: mfa` (Cloudflare's 2FA via TOTP or hardware key). Document in chapter 05 §3 with the literal policy YAML.
2. **Reduce session_duration** to 8h (workday) instead of 24h — limits replay window.
3. **Add `require: country_code`** with the author's expected country list (or document the trade-off if user travels).
4. **Add daemon-side log alarm**: every JWT validation logs `jwt_email`, `jwt_iat`, source IP (from `Cf-Connecting-Ip` header). Daemon emits a desktop notification on first-seen IP per session (Chapter 05 §4 already logs `jwt_email` for audit; extend with a "new IP" alert).
5. **Document compromise recovery** in chapter 05: "if GitHub session compromise suspected: (a) revoke OAuth grant in github.com/settings/applications, (b) rotate Access app secret in Cloudflare dashboard, (c) revoke active sessions in CF Zero Trust → Sessions, (d) re-run setup wizard step 2."

### P1-1 (must-fix): `cloudflared` binary supply chain — pinning mechanism not concrete
**Where**: chapter 05 §1, chapter 10 R9, chapter 11 §8 ("`cloudflared` ... bundled binary, version pinned in `daemon/scripts/cloudflared-version.txt`")
**Issue**: "Version pinned in a text file" is half a supply-chain story. The other half: download URL? checksum verification? signature verification? The spec doesn't say:
1. Where does the build script DOWNLOAD `cloudflared` from? (Cloudflare's GitHub releases? An npm package?)
2. Is the download verified against a published SHA256? (Cloudflare publishes SHA256 with releases.)
3. Is the binary signed? (Cloudflare signs Win binaries; macOS notarized; Linux signed via apt repo key.) Does the build verify the signature?
4. Is the bundled binary re-checked at daemon runtime (e.g. on first spawn) to detect post-installer tampering?
**Why this is P1**: Supply-chain compromise of a bundled binary = RCE in user's daemon process (which already has high privilege). Standard hygiene: pinned URL + pinned SHA256 + signature verification at build time + optional re-verification at runtime.
**Suggested fix**: Lock in chapter 05 §1 (or new §1.X):
1. Build script downloads `cloudflared` from `https://github.com/cloudflare/cloudflared/releases/download/<version>/cloudflared-<platform>-<arch>` (canonical Cloudflare release).
2. SHA256 of expected binary stored in `daemon/scripts/cloudflared-checksums.json` (one line per platform/arch). Build fails if downloaded SHA mismatches.
3. Build script verifies Cloudflare's release signature where applicable (Win signtool, macOS codesign).
4. Pin renewal: documented quarterly cadence (chapter 10 R9 says quarterly; cross-link to chapter 05).
5. Daemon at first `cloudflared` spawn (before passing the token) verifies binary SHA matches expected (defends post-installer tampering); fail-closed.

### P1-2 (must-fix): JWT validation policy fields not locked (algorithm, clock skew, AUD uniqueness)
**Where**: chapter 05 §4 (cross-ref with chapter 02 R2 P1-2)
**Issue**: See chapter 02 review P1-2. The pseudo-code in chapter 05 §4 shows `jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE })` without locking algorithm, clock skew, required claims, and AUD uniqueness. Same finding; fixer should resolve in one chapter (chapter 05 §4) and reference from chapter 02 §8.
**Why this is P1**: as in chapter 02 review.
**Suggested fix**: as in chapter 02 review P1-2.

### P1-3 (must-fix): Daemon JWT interceptor uses `req.contextValues.get(localTransportKey)` for local bypass — bypass mechanism risk
**Where**: chapter 05 §4 + §5
**Issue**: The local-bypass mechanism is "if request arrived on local socket transport, set `localTransportKey: true` in context, JWT interceptor checks and skips." Two concerns:
1. **Order-dependency**: the transport-tagging code MUST run BEFORE the JWT interceptor on the chain. If a future PR reorders Connect interceptors (e.g. inserts a logging interceptor that resets context), the JWT interceptor sees `undefined` and either rejects local Electron (visible bug) OR — if the bypass uses default-true semantics — auth-fails-open (invisible bug).
2. **The `localTransportKey` semantics**: presence-or-absence of a context key is a fragile gate. Should be a positive enum: `req.contextValues.get(transportTypeKey) === 'local-pipe'` and JWT interceptor explicitly enforces `transportType === 'remote-tcp'` requires JWT. Default should be `transportType === 'remote-tcp'` (fail-closed) if untagged.
3. **No test mentioned**: chapter 08 L2 contract tests should include "request on local socket bypasses JWT" AND "request on TCP listener WITHOUT JWT is rejected" AND "request on TCP listener WITH spoofed `localTransportKey: true` header is rejected" (i.e. the context-key MUST be set by the listener, never derivable from a header).
**Why this is P1**: auth-bypass-on-misconfiguration is the classic Connect/gRPC interceptor footgun.
**Suggested fix**: Lock in chapter 05 §4:
1. Transport type stored as positive enum (`local-pipe` | `remote-tcp`) set by the listener at connection accept time, never read from request headers.
2. JWT interceptor logic: `if (transportType !== 'local-pipe') { ...require JWT... }`. Default-fail-closed: untagged requests rejected.
3. Three contract tests in chapter 08 L2 covering local-bypass-positive, remote-no-JWT-rejected, remote-spoofed-tag-rejected.
4. JWT interceptor MUST be the first interceptor in the chain after transport-tagging, before any RPC handler.

### P2-1 (nice-to-have): `cloudflared --metrics 127.0.0.1:0` — random port also unauthenticated
**Where**: chapter 05 §1 spawn args
**Issue**: `--metrics 127.0.0.1:0` opens an unauth metrics endpoint on a random local port, daemon polls it for health (chapter 05 §1 "health: poll `--metrics` HTTP endpoint every 30s"). Same DNS-rebinding / local-process risk as the dev TCP listener (chapter 04 R2 P0-1) but lower stakes (metrics, not RPC). Worth mitigating.
**Why this is P2**: low-impact info disclosure (tunnel stats); still good hygiene.
**Suggested fix**: Bind metrics to a Unix-domain socket (`--metrics unix:/tmp/...`) where supported, or document that the metrics port reveals tunnel routing config which an attacker could use to fingerprint the user.

### P2-2 (nice-to-have): Tunnel hostname enumerable + no rate-limit at daemon
**Where**: chapter 10 R6 + chapter 05 §2
**Issue**: Spec acknowledges (R6) that the random `<random>.cfargotunnel.com` is enumerable. Beyond that, there's no rate-limiting at the daemon for failed JWT validations (chapter 02 §8 mentions a v0.3 pre-accept rate cap of 50/sec for connections, re-implemented for HTTP/2). Per-IP rate limit on JWT-failed requests would slow brute force and reduce log noise.
**Why this is P2**: Cloudflare provides DDoS protection at the edge; daemon-level rate limit is defense-in-depth.
**Suggested fix**: Add to chapter 05 §4: "JWT interceptor rate-limits per-source-IP failures: 10 failures in 60s → reject with 429 for the next 60s. Source IP from `Cf-Connecting-Ip` header (set by Cloudflare; trust because the only path to TCP listener is via cloudflared)."

## Cross-file findings

P0-2 (Access policy single-factor) interacts with chapter 07 A5 (JWT replay accepted) and chapter 10 R3 (CF tier change risk). Chapter 07 A5 should be downgraded from "explicitly accept" to "mitigated by 2FA + reduced session duration".
