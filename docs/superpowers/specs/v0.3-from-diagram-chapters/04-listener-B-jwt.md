# 04 — Listener B: TCP loopback + CF-Access JWT interceptor

> **Key v0.3 invariant:** Listener B is **fully bound, fully tested, fully validated** in v0.3, even though no v0.3 client connects to it. The cost of leaving it for v0.4 is precisely the rework v0.3 forbids.

## Purpose

Listener B is the entry point for `cloudflared` (when v0.4 enables remote access). It accepts only requests carrying a valid Cloudflare Access JWT in the `Cf-Access-Jwt-Assertion` header. Trust is bound to **transport identity** (this listener) plus the JWT validation interceptor. There is no peer-cred on Listener B (cloudflared is local but its incoming requests are external by intent).

**Why:** final-architecture §2 principles 3, 4, 5. Listener B is the *only* path from the public internet into the daemon (via cloudflared); JWT verification is the gate.

## Bind contract (MUST in v0.3)

- **Transport:** TCP, IPv4, `127.0.0.1`. Never `0.0.0.0`. Never `::` (no IPv6 dual-stack — explicit IPv4-only to keep the bind surface minimal and CI-lintable).
- **Port:** ephemeral. Daemon asks the OS for `port: 0`, captures the assigned port, publishes it via discovery file (see [03](./03-listener-A-peer-cred.md) §"Address discovery"). No fixed `PORT_TUNNEL` env var; the constant `PORT_TUNNEL` in the diagram is a label, not a literal.
- **Bind ordering:** Listener B MUST be bound **before** the discovery file is written and **before** Listener A is published as ready. Both listeners ready before daemon emits `/healthz: ok`.
- **Bind on every boot:** there is no "remote disabled → don't bind Listener B" branch in v0.3. Always bind. The cloudflared sidecar's enabled/disabled flag (v0.4) governs whether *cloudflared* runs, never whether Listener B exists.

**Why always-bind:** if Listener B's bind path is gated on a feature flag, v0.4 must add the bind path (= rework). Always-bind makes v0.3 code identical to v0.4 code on this axis.

### CI lint (mandatory)

- A repo-level lint check MUST forbid binding Listener B to anything other than `127.0.0.1`. Implement as a grep/AST check in CI over `daemon/src/connect/**` for any `listen(*, ...)` whose host argument is not the literal `'127.0.0.1'` or a constant resolving to it.
- Test the lint with a known-bad fixture (so a future refactor that disables it gets caught).

## CF-Access JWT interceptor

### Behavior

On every Listener-B Connect-RPC request:

1. Extract `Cf-Access-Jwt-Assertion` header (case-insensitive). Missing → respond `unauthenticated` with code `Unauthenticated`.
2. Parse JWT (RS256 only — see "Algorithm policy" below). Malformed → `Unauthenticated`.
3. Look up signing key by `kid` in cached JWKS (see "JWKS cache" below). Missing key → JWKS refresh → still missing → `Unauthenticated`.
4. Verify signature. Invalid → `Unauthenticated`.
5. Verify claims:
   - `aud` MUST equal the configured Access Application AUD (one entry, single-tenant).
   - `iss` MUST equal `https://<team>.cloudflareaccess.com` (configured).
   - `exp` MUST be in the future (with `clockTolerance` of 30 seconds).
   - `nbf` (if present) MUST be in the past (with same tolerance).
6. Extract identity (`email` / `sub`) and attach to the request context for downstream handler logging. Identity is **not** used for authorization in v0.3 (single-user system, principle 10).
7. Call `next()`.

### Algorithm policy

- Accept only `RS256`. Reject `none`, `HS256`, `RS512`, `ES*`, `PS*`. Cloudflare Access uses RS256; pinning prevents algorithm-confusion attacks.

### JWKS cache

- Endpoint: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (team URL configured at install time; v0.3 reads from a config file or env var, default unset → interceptor fails closed on first request).
- Cache TTL: 1 hour (refresh on miss-by-`kid` or after TTL).
- Cooldown after a failed fetch: 60 seconds (don't hammer cf on outage).
- **Bind-gate:** daemon MUST NOT consider itself "remote-ready" (a future v0.4 readiness signal) until the JWKS has been pre-warmed at least once. In v0.3 this gate is implemented but unused (no v0.3 caller asks "is remote ready"). In v0.4 the cloudflared spawn flow consumes this gate.

**Why pre-warm:** if the first remote request arrives before JWKS is cached, the user-facing first-request latency includes a JWKS fetch. Pre-warm hides it.

### Fail-closed semantics

- JWKS endpoint unreachable AND no cached keys → reject all requests with `Unauthenticated`. Never "let it through because cf is down".
- Configured AUD missing or empty string → daemon refuses to bind Listener B and exits with a clear config error. (Strict in v0.3 to surface misconfiguration loudly; the config can default to a placeholder AUD that is impossible to validate against, so the daemon binds but every request fails — see "v0.3 default config" below.)

### v0.3 default config

In v0.3 there is no cloudflared and no team. The daemon ships with:

- AUD = `""` (empty) by default → **interceptor MUST treat this as "no AUD configured" and reject every Listener-B request with `Unauthenticated`** (NOT a daemon-bind-time fatal; daemon binds Listener B regardless, the interceptor just rejects all traffic).
- Team URL = unset → JWKS fetch never attempted (no network request unless explicitly configured).

This means in v0.3, Listener B is bound, accepts TCP connections, completes HTTP/2 handshake, then any RPC is rejected `Unauthenticated`. Tests assert this behavior. v0.4 ships the configuration UI and JWKS fetch becomes live.

**Why this shape:** keeps zero code paths conditional on "is this v0.3 or v0.4". The interceptor logic is identical; only the config differs.

## UT matrix (MUST in v0.3)

| # | Scenario                                                  | Expected      |
| - | --------------------------------------------------------- | ------------- |
| 1 | Valid JWT (RS256, correct aud/iss/exp, kid in JWKS)       | request passes |
| 2 | Missing `Cf-Access-Jwt-Assertion` header                  | `Unauthenticated` |
| 3 | Malformed JWT (not three dot-separated base64url segments) | `Unauthenticated` |
| 4 | JWT with `alg: none`                                      | `Unauthenticated` |
| 5 | JWT with `alg: HS256` (algorithm confusion)               | `Unauthenticated` |
| 6 | JWT signed by wrong key (kid not in JWKS)                 | JWKS refresh, then `Unauthenticated` if still missing |
| 7 | JWT with wrong `aud`                                      | `Unauthenticated` |
| 8 | JWT with wrong `iss`                                      | `Unauthenticated` |
| 9 | JWT expired (`exp` < now − tolerance)                     | `Unauthenticated` |
| 10 | JWT not-yet-valid (`nbf` > now + tolerance)              | `Unauthenticated` |
| 11 | JWT within clock-tolerance window (skewed by 20 s)       | passes (tolerance 30 s) |
| 12 | JWKS endpoint returns 5xx, cache empty                   | `Unauthenticated`, fail-closed |
| 13 | JWKS endpoint returns 5xx, cache has valid kid           | passes (cache used) |
| 14 | Cooldown: after failed JWKS fetch, second failed lookup within 60 s does NOT re-fetch | one network call observed |
| 15 | Empty AUD configured → interceptor rejects every request | `Unauthenticated`, no JWKS fetch attempted |
| 16 | Two requests with same kid, second within TTL            | one JWKS fetch observed |
| 17 | TTL expiry (>1h) triggers refresh on next request        | second JWKS fetch observed |

Test fixtures: hand-rolled RSA keypair generated in test setup; fake JWKS server via `nock` or a local test HTTP server.

## Why this exhaustive coverage in v0.3 even with no live caller

- The interceptor IS the trust boundary for v0.4 remote access. Catching a bug here in v0.3 is free; catching it in v0.4 means a vulnerability shipped to remote users.
- All 17 cases are pure-unit (no network, no real cloudflared). They cost minutes to run; running them in v0.3 costs nothing extra.
- Reusing this UT matrix verbatim in v0.4 = zero incremental test work in v0.4.

## Per-RPC logging (Listener B)

- Every accepted Listener-B RPC logs `{ rpc, identity_email, identity_sub, jwt_iat, jwt_exp, latency_ms, status }`.
- Every rejected request logs `{ rpc, reject_reason, jwt_kid_or_null }`. JWT itself NOT logged.

**Why:** when remote access is wired in v0.4 we want post-hoc visibility on auth-rejections without retrofitting logging.

## Cross-refs

- [01 — Goals (G1)](./01-goals-and-non-goals.md)
- [02 — Process topology](./02-process-topology.md)
- [03 — Listener A](./03-listener-A-peer-cred.md)
- [07 — Connect-Node server scaffold (interceptor mount per-listener)](./07-connect-server.md)
- [15 — Testing strategy (UT matrix table reused as canonical)](./15-testing-strategy.md)
- [16 — Risks / open questions (team-URL config UX deferred to v0.4)](./16-risks-and-open-questions.md)
