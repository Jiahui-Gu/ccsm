# 05 — Cloudflare layer (Tunnel + Access + JWT middleware)

## Context block

The web client lives on Cloudflare Pages. The user's daemon lives on their Windows box behind whatever NAT / firewall / dynamic IP that machine has. **Cloudflare Tunnel** stitches them together: the daemon (or a `cloudflared` sidecar) opens an outbound connection to Cloudflare; Cloudflare assigns a stable public hostname; HTTPS requests to that hostname are routed back over the tunnel. **Cloudflare Access** sits in front as a zero-trust authenticator: every request is intercepted, redirected to GitHub OAuth on first hit, and signed with a short-lived JWT. The daemon validates the JWT on every remote request; local-socket requests bypass it (peer-cred is the local trust boundary, see chapter 02 §8).

**Terms in this chapter** (per R6 P1-3):

**Tunnel-vs-binary one-liner (per R6 r2 P1):** "Cloudflare Tunnel" (capitalized) is the Cloudflare product/service that provides outbound-only secure ingress; `cloudflared` (code voice) is the daemon binary distributed by Cloudflare that implements a Tunnel client. The two are NOT interchangeable: docs reference the product by name, code references the binary by filename.

- **Cloudflare Tunnel** (capitalized) — the Cloudflare product/service.
- `cloudflared` (code voice) — the binary that runs locally as a sidecar.
- *tunnel* (lowercase) — a single tunnel instance / outbound connection.
- **Cloudflare Access** (capitalized) — the zero-trust authenticator product.
- **JWKS** — JSON Web Key Set; Cloudflare's public-key endpoint for JWT signature verification.
- **IdP** — Identity Provider (GitHub OAuth in our config).
- **AUD** — JWT `aud` (audience) claim; Cloudflare Access app's unique tag.

## TOC

- 1. Cloudflare Tunnel (`cloudflared`)
- 1.1 `cloudflared` binary supply chain
- 1.2 Idle-session eviction (cross-ref ch06 §5, ch10 R5)
- 2. Tunnel hostname strategy
- 3. Cloudflare Access — application config
- 4. JWT validation middleware on the daemon
- 4.1 JWT validation policy locks (algorithm, claims, clock skew)
- 4.2 JWT validation test matrix (cross-ref ch08 §3)
- 5. Local vs remote ingress on the daemon
- 6. Setup flow (first-time user)
- 6.1 Secret-handling discipline (tunnel token + AUD)
- 7. Cost (free tier all the way)
- 8. Operational caveats
- 9. Testability hooks

## 1. Cloudflare Tunnel (`cloudflared`)

**Decision (lock):** `cloudflared` runs as a **sidecar process spawned by the daemon** when remote access is enabled, not as a separate user-installed daemon. The daemon's binary bundle ships `cloudflared` for each platform (Win/Mac/Linux x64+ARM64) inside the package.

**Why sidecar-spawned:**
1. One install for the user — no "now install cloudflared separately".
2. Daemon owns the tunnel lifecycle: starts on remote-enable, stops on remote-disable, restarts on tunnel crash.
3. Bundling the binary means a known-good version (no "user has cloudflared 2019 from somewhere").

**Spawn args** (presented as the actual TS args list the daemon uses, per R6 P2-1):

```ts
const args = [
  'tunnel',
  '--no-autoupdate',
  '--protocol', 'http2',                  // see §8 for protocol rationale
  '--url', 'http://127.0.0.1:7879',       // prod TCP listener (see §5; dev uses :7878)
  '--metrics', '127.0.0.1:0',             // ephemeral port; daemon reads from spawn output
  '--loglevel', 'info',                   // M4 dogfood; tighten to 'warn' post-stable
  '--logfile', '~/.ccsm/cloudflared.log',
  '--token', storedTunnelToken,           // SecureBuffer, see §6.1
];
child_process.spawn(cloudflaredPath, args, { detached: false });
```

The daemon's TCP listener binds `127.0.0.1:7879` only when remote-access is enabled (see §5). `cloudflared` proxies the public Tunnel hostname to that listener.

**Tunnel auth model:** the user creates a tunnel via the Cloudflare dashboard (one-time, in the setup wizard, see §6) and the resulting **tunnel token** (a long string) is stored via the OS keychain (see §6.1 for the exact storage scheme). On daemon start, if remote-access is enabled, the token is fetched from the keychain and `cloudflared` is spawned.

**Why not let the daemon create the tunnel itself via API:** Cloudflare's tunnel-create API requires an account-level API token, which the user would have to paste. The dashboard flow is one-time and uses the user's existing browser session. Less friction.

**Tunnel token rotation:** if the user revokes the token in Cloudflare dashboard, the spawned `cloudflared` exits with auth error; daemon logs and surfaces a `cloudflare.unreachable` banner in the desktop UI (sticky; see §1 lifecycle below). User re-runs the setup wizard.

**`cloudflared` lifecycle (with explicit recovery, per R3 P0-1 / R4 P1-1):**
- Spawn: `child_process.spawn` with `detached: false` (dies with daemon). Spawn factory MUST be injectable (`spawnCloudflared = childProcess.spawn`) for tests (per R5 P1-1).
- Health: poll `--metrics` HTTP endpoint every **60s** (per R4 P1-1; halved from initial 30s draft to reduce overhead); restart on 3 consecutive failures.
- End-to-end probe (per R3 P1-3): every 60s, daemon issues an HTTPS `GET https://<tunnel-host>/healthz` to its own tunnel hostname (round-trip via Cloudflare edge). 3 consecutive failures flip the surface to `cloudflare.unreachable` even when `--metrics` reports green. Cost: ~one outbound HTTPS/min.
- Restart backoff: exponential, capped at 60s, max 10 attempts in 30 minutes.
- **After exhaustion (per R3 P0-1, R4 P1-1):** do NOT stop forever. Fall back to a **steady-state slow tick: 1 attempt per 5 min, indefinitely**. Reset to fast backoff on first success.
- **Network-recovery trigger (per R3 P0-1):** subscribe to the OS network-up event (Win SENS, mac SCNetworkReachability, Linux NetworkManager DBus). On network-up, immediately restart the fast-backoff cycle (don't wait for the 5-min slow tick). When the network listener is unavailable (e.g. headless Linux without NM), fall back to slow-tick only — log the degraded mode at boot.
- **User surface:** the `cloudflare.unreachable` banner (taxonomy in chapter 04 §6, failure list in chapter 07 §2) is **sticky** while the slow-tick is engaged, and exposes a "Retry now" button (forces an immediate fast cycle), the last-error message, and a "View log" link to `~/.ccsm/cloudflared.log`.
- Logs: tee `cloudflared` stdout/stderr to `~/.ccsm/cloudflared.log` (rotated via pino-roll, same convention as daemon log per v0.3 frag-3.7). **Cap (per R3 P2-1):** 50 MB × 5 files. M4 dogfood uses `--loglevel info`; tighten to `warn` once stable.

### 1.1 `cloudflared` binary supply chain (per R2 P1-1, R5 P2-2)

**Locks:**
1. **Source (lock):** build script downloads `cloudflared` from the canonical Cloudflare release URL — `https://github.com/cloudflare/cloudflared/releases/download/<version>/cloudflared-<platform>-<arch>` (e.g. `cloudflared-windows-amd64.exe`).
2. **Pinned version:** stored in `daemon/scripts/cloudflared-version.txt`. Renewal cadence: quarterly (cross-link chapter 10 R9).
3. **Pinned SHA256:** stored in `daemon/scripts/cloudflared-checksums.json` (one entry per `<platform>-<arch>`). Build fails if downloaded SHA mismatches the pinned value.
4. **Release-signature verification at build time:** Win uses `signtool verify /pa`; macOS uses `codesign --verify`; Linux verifies the GPG signature against Cloudflare's apt repo key. Build fails if signature does not verify.
5. **Runtime SHA re-check (defense against post-installer tampering):** on first `cloudflared` spawn after daemon boot (before passing the token), daemon re-computes SHA256 of the bundled binary and compares against the pinned value from `cloudflared-checksums.json`. Mismatch = log + refuse to spawn + surface `cloudflare.unreachable` with reason `binary tampered`. Fail-closed.
6. **Build-time version-binary cross-check (per R5 P2-2):** CI step runs `cloudflared --version` on the bundled binary and asserts the reported version matches `cloudflared-version.txt`. Catches "updated the version file but forgot to swap the binary" and vice versa.

### 1.2 Idle-session eviction (per R3 P1-2; cross-ref ch06 §5, ch10 R5)

Auto-start daemon (chapter 01 G6) means the daemon runs 24/7 across multi-day intervals. Without an eviction policy, PTY headless buffers and per-subscriber fanout buffers hold memory indefinitely.

**Policy (lock for v0.4):** a session with **zero subscribers AND no PTY output for 24h** is buffer-trimmed:
- Scrollback drops from 10k lines to last **1k lines**.
- Per-subscriber fanout buffer (1 MiB) is freed.
- Session metadata (sid, cwd, name, exit status) persists in SQLite.

**Re-attach behavior:** on re-subscribe, reconstruct from SQLite + fresh PTY state. Already-exited sessions show only the trimmed snapshot. Live sessions resume PTY output streaming from the trim point forward.

**Implementation lives in chapter 06 §5.** This subsection states the policy lock so chapter 05 readers know remote-access doesn't accumulate indefinite buffers.

## 2. Tunnel hostname strategy

**Default (lock):** Cloudflare-assigned `<random>.cfargotunnel.com` hostname (ends up looking like `e3a9b2c1.cfargotunnel.com`). Auto-provisioned at tunnel-create time; no DNS configuration needed.

**Custom domain (opt-in):** if the user owns a domain on Cloudflare DNS, they can route `daemon.<their-domain>` to the tunnel via a CNAME to `<tunnel-id>.cfargotunnel.com`. Configured via Cloudflare dashboard, not the daemon. Daemon's Settings UI just shows the active hostname read from `cloudflared`'s metrics endpoint.

**Why default to the random hostname:** zero-config. The user gets remote access from the first session of the wizard with no domain purchase or DNS setup.

**Why custom domain is opt-in only:** requires the user to own a domain. Can't be the default.

**Hostname for the web SPA (Cloudflare Pages):** separate from the tunnel hostname. Pages assigns `<project>.pages.dev` (e.g. `ccsm-app.pages.dev`); the user MAY add a custom CNAME (e.g. `app.<their-domain>`) via Pages settings. Both Pages and Tunnel hostnames go behind Cloudflare Access (§3) — same Access policy covers both.

## 3. Cloudflare Access — application config

**Application** = a Cloudflare Access "self-hosted" application protecting the tunnel hostname AND the Pages hostname.

**Identity provider:** GitHub OAuth (free, included).

**Policy (locked, per R2 P0-2 — adds 2FA + tighter session):**

```yaml
include:
  - emails: ["<author-github-email>"]      # placeholder; user fills in setup wizard
require:
  - identity_provider: github
  - mfa:
      provider: github                      # GitHub-side TOTP / WebAuthn
session_duration: 8h                        # was 24h; reduced to limit replay window
auto_redirect_to_identity: true
```

**Why GitHub OAuth IdP:** the project already requires GitHub for source code; reusing the identity is zero-friction. Cloudflare Access GitHub IdP is free and stable.

**Why MFA required (R2 P0-2):** the JWT grants full PTY access on the user's primary workstation. "Logged into GitHub" alone is insufficient (single factor, GitHub session compromise = full RCE). MFA (GitHub-side TOTP or WebAuthn, surfaced via Cloudflare Access `require: mfa`) raises the bar to "GitHub session AND second factor".

**Why `auto_redirect_to_identity`:** skips Access's "pick an IdP" page since there's only one. User clicks the URL → straight to GitHub login → straight back to the app.

**Why 8h session (was 24h):** balance between "doesn't make me sign in every page load" and "stale device gets locked out reasonably soon". 8h ≈ workday; bounds the replay window if a JWT leaks.

**Country gating (deferred):** `require: country_code` is a v0.5+ option once the author has a stable travel pattern documented. v0.4 omits to avoid lockout-during-travel. Why deferred: insufficient single-user data to pick a list.

**Not surfaced in Settings (per R1 P2-2):** `session_duration`, MFA toggle, country gate are Cloudflare-side policy values, NOT v0.4 user-tunable settings. The user changes them in the Cloudflare dashboard if desired.

**Multi-user later (N2 in chapter 01):** when the user opens this to friends, the policy gains more emails. v0.4 keeps it single-user.

**Compromise recovery (per R2 P0-2):** if GitHub session compromise is suspected:
1. Revoke the OAuth grant at `github.com/settings/applications`.
2. Rotate the Access app secret in the Cloudflare dashboard.
3. Revoke active sessions in Cloudflare Zero Trust → Sessions.
4. Re-run setup wizard step 2 (re-paste team name + AUD; nothing else changes).

**JWT delivery:** Cloudflare Access sets the JWT in:
1. **`Cf-Access-Jwt-Assertion` HTTP request header** on every authenticated request (browser → daemon). This is what the daemon validates.
2. **`CF_Authorization` cookie** on the user's browser, so the SPA itself doesn't need to manage the token.

The web client treats the JWT as opaque — Cloudflare and the daemon handle issuance and validation respectively. No JWT parsing in the browser.

## 4. JWT validation middleware on the daemon

**Decision (lock):** Connect interceptor on the daemon's data-socket Connect server, applied **only when the request arrives via the remote (TCP/Tunnel) listener**, not the local socket.

**Implementation:**

```ts
// daemon/src/connect/jwt-interceptor.ts (new)
import { createRemoteJWKSet, jwtVerify } from 'jose';

const cfTeamName = settings.cloudflare_team_name;     // from SQLite (§6)
const cfAud      = settings.cloudflare_app_aud;       // from SQLite (§6)
const JWKS_URL = `https://${cfTeamName}.cloudflareaccess.com/cdn-cgi/access/certs`;
const ISSUER   = `https://${cfTeamName}.cloudflareaccess.com`;
const AUDIENCE = cfAud;

const jwks = createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30000 });

// in-process JWT result cache (per R4 P1-2): same cookie ⇒ many RPCs ⇒ one verify
const verifyCache = new Map<string, { payload: JWTPayload; expMs: number }>();

export const jwtInterceptor: Interceptor = (next) => async (req) => {
  const transportType = req.contextValues.get(transportTypeKey); // positive enum (§5)
  if (transportType === 'local-pipe') return next(req);          // local bypass
  // fail-closed: untagged or 'remote-tcp' both require JWT
  const token = req.header.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new ConnectError('missing access JWT', Code.Unauthenticated);

  const cached = verifyCache.get(token);
  const now = Date.now();
  if (cached && cached.expMs > now) {
    req.contextValues.set(jwtPayloadKey, cached.payload);
    return next(req);
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256'],            // lock: Cloudflare uses RS256; reject 'none' / HS*
      clockTolerance: '30s',            // tolerate Windows clock drift
      requiredClaims: ['exp', 'iat', 'iss', 'aud', 'email'],
    });
    const expMs = (payload.exp ?? 0) * 1000;
    verifyCache.set(token, { payload, expMs });
    req.contextValues.set(jwtPayloadKey, payload);
  } catch (err) {
    throw new ConnectError(`invalid access JWT: ${err.message}`, Code.Unauthenticated);
  }
  return next(req);
};
```

**Why `jose` library:** stable, well-audited, supports Cloudflare's JWKS format out of the box. Used by every other Node project doing JWT validation.

**Why `createRemoteJWKSet` with caching:** the JWKS endpoint is hit on first request, cached, refreshed on key rotation (Cloudflare rotates keys ~yearly). 30s cooldown on miss prevents JWKS-fetch storms under load.

**JWKS pre-warm at boot (per R3 P1-1, R4 P1-2):** daemon proactively fetches JWKS at startup with retry 1s → 30s exponential backoff. **Remote ingress refuses to bind until JWKS is cached.** If JWKS is still unfetchable after 5 min, log + retry every 5 min in background; remote ingress stays unbound. Avoids the "rejected requests vs closed listener" ambiguity for the client (clean ECONNREFUSED instead of "all requests fail unauthenticated").

**Why fail-closed (no token = reject):** the only requests that should reach this middleware are remote (Tunnel) requests, which Cloudflare Access ALWAYS adds the header to. Missing header = either misconfiguration or attacker bypassing Access. Either way, reject.

**Local bypass mechanism (per R2 P1-3):** transport type is a **positive enum** set by the listener at connection-accept time, NEVER read from a request header. Values: `'local-pipe'` (named-pipe / Unix-socket listener) or `'remote-tcp'` (TCP listener fronted by `cloudflared`). The JWT interceptor explicitly checks `transportType === 'local-pipe'` to bypass; **untagged requests fail closed** (treated as `'remote-tcp'` for safety). The JWT interceptor MUST be the first interceptor in the chain after transport-tagging, before any RPC handler.

**Why a transport-level tag rather than per-listener interceptor:** simpler. One Connect server, one interceptor chain, one decision rule. The local listener and remote listener share handlers, transport tag differentiates.

**Bootstrap (knowing `<team-name>` and `<aud>`):** the user provides these in the setup wizard (§6) and they're stored in `settings.cloudflare_team_name` + `settings.cloudflare_app_aud` in SQLite (team name is not a secret; AUD is sensitive but not equivalent to the tunnel token — see §6.1 for handling). Daemon reads at startup; remote ingress refuses to start if either is missing.

**JWT claims used:** the daemon doesn't currently need the email claim for authorization (single user — if the JWT validates, you're authorized). Logged for audit (`pino.info({ jwt_email: payload.email, traceId })`). Multi-user (N2) adds per-claim authorization later.

**Audit + new-IP alert (per R2 P0-2):** every JWT validation logs `{ jwt_email, jwt_iat, source_ip }` where `source_ip` comes from the `Cf-Connecting-Ip` header (set by Cloudflare; trusted because the only path to the TCP listener is via `cloudflared`). Daemon emits a desktop notification on **first-seen IP per session** ("New device signed in from <ip>; if this wasn't you, follow compromise recovery in Settings").

### 4.1 JWT validation policy locks

These are duplicated here so chapter 05 is the canonical lock; chapter 02 §8 references this section (cross-ref R2 P1-2 / chapter 02 P1-2).

| Policy | Value | Why |
|---|---|---|
| Algorithm allow-list | `['RS256']` | Cloudflare Access signs RS256; rejects `alg: none` / HS* / unexpected algs. |
| Required claims | `exp`, `iat`, `iss`, `aud`, `email` | All five MUST be present and parsed; missing any = reject. |
| `iss` check | `https://<team-name>.cloudflareaccess.com` (exact match) | Locks to this team's Access deployment. |
| `aud` check | configured AUD (exact match, single value) | Prevents JWTs minted for OTHER apps under the same team from being accepted. |
| `clockTolerance` | `30s` | Tolerates Windows machine clock drift. |
| JWKS cache | `cooldownDuration: 30000` (30s) | Throttles JWKS refetch under JWKS-miss storms. |
| In-process verify cache | TTL = `payload.exp - now` | Cookie-then-many-RPCs is dominant case; one verify per cookie. |
| Verify perf budget | ≤ 5 ms p99 over 1000 calls | Measured in M4 dogfood gate. |

**Daemon-side rate limit on JWT failures (per R2 P2-2 → promoted to lock here, since trivial and defense-in-depth):** per-source-IP failure cap of **10 failures in 60s → reject with HTTP 429 for the next 60s**. Source IP from `Cf-Connecting-Ip` header (trusted as above).

### 4.2 JWT validation test matrix (per R5 P0-1)

The JWT interceptor IS the remote auth boundary. Negative tests are mandatory; chapter 08 §3 (contract tests) defines a `jwt-validation-matrix` test list with the cases below. Each case MUST result in `Code.Unauthenticated` and a specific log-tag for grep-ability.

| Case | Expected | Log tag |
|---|---|---|
| Missing `Cf-Access-Jwt-Assertion` header | reject | `jwt.missing` |
| Wrong `aud` (signed by same team, different app) | reject | `jwt.bad-aud` |
| Wrong `iss` | reject | `jwt.bad-iss` |
| Expired (`exp` < now − 30s tolerance) | reject | `jwt.expired` |
| `alg: none` | reject | `jwt.alg-not-allowed` |
| `alg: HS256` (signed with shared secret) | reject | `jwt.alg-not-allowed` |
| Missing `kid` in header | reject | `jwt.kid-missing` |
| Signed with attacker's RSA key | reject | `jwt.sig-invalid` |
| JWKS endpoint unreachable | reject + ingress unbound (per §4 pre-warm rule) | `jwt.jwks-unreachable` |
| JWKS rotation mid-request (token signed with old key just rotated out) | reject (after one re-fetch) | `jwt.kid-not-found` |
| Local-pipe transport, no JWT | accept (bypass) | `jwt.local-bypass` |
| Remote-TCP, valid JWT | accept | `jwt.ok` |
| Remote-TCP, **header-spoofed `transportTypeKey`** | reject | `jwt.transport-spoof` |

**Real-CF shape test (per R5 P1-3):** in addition to the mock JWKS matrix, chapter 08 §5 includes `web-jwt-realshape` — a checked-in JWT recorded once from a real Cloudflare Access deployment (sensitive claims redacted / regenerated). Re-record quarterly. This catches "Cloudflare changed the claim format" without depending on the live-network nightly (chapter 08 §7).

**Per-PR vs nightly split:** mock-JWKS matrix runs every PR (fast, deterministic). Real-CF live-network probe runs nightly only. The recorded-shape test bridges the gap (per-PR + real claim shape).

## 5. Local vs remote ingress on the daemon

The daemon binds **three** listeners in v0.4:

| Listener | Address | Auth | Purpose |
|---|---|---|---|
| Control socket | `\\.\pipe\ccsm-sup` (Win) / `~/.ccsm/daemon-sup.sock` (Unix) | peer-cred + HMAC (v0.3 carryover) | Supervisor RPCs (`/healthz`, `daemon.shutdown*`, etc.) |
| Data socket (local) | `\\.\pipe\ccsm-daemon` (Win) / `~/.ccsm/daemon.sock` (Unix) | peer-cred (v0.3 §3.1.1) | Connect over HTTP/2 — Electron renderer talks here |
| Data socket (remote, prod) | TCP `127.0.0.1:7879` (only when remote enabled) | Cloudflare Access JWT | Connect over HTTP/2 — `cloudflared` proxies external traffic here |

**Dev TCP listener separate (per R4 P1-3):** chapter 04 §5's Vite-dev-mode TCP listener binds `127.0.0.1:7878` (unauth, dev-only). Prod cloudflared TCP binds `127.0.0.1:7879`. Different ports prevent `EADDRINUSE` collisions when a developer has both modes engaged. Daemon refuses to start the prod TCP listener if `CCSM_DAEMON_DEV_TCP=1` is set, AND refuses to start the dev TCP if remote-access is enabled — explicit mutual exclusion at startup with a clear error message.

**Why bind TCP only when remote enabled:** least exposure. If the user never enables remote, no TCP socket is open, no `cloudflared` is running. Local-only mode = unchanged from v0.3 surface area.

**TCP bind is `127.0.0.1`, never `0.0.0.0`:** all external traffic MUST go through `cloudflared`'s outbound connection. Binding `0.0.0.0` would expose the unauth'd Connect surface from the LAN.

**Production TCP listener Host-header + no-JWT-exempt-routes lock (per R2 P0-2; ch04 §5 cross-refs this paragraph):**
1. **Host-header binding (lock):** the prod TCP listener (`127.0.0.1:7879`) MUST validate the `Host` header on every incoming request equals `127.0.0.1:7879`, `localhost:7879`, or the configured `cloudflared`-set Host (the public Tunnel hostname `<random>.cfargotunnel.com` or the user's optional custom domain per §2). Any other value MUST be rejected with HTTP 421 Misdirected Request **before any handler or interceptor runs**. This defeats DNS rebinding attacks from any browser tab on the user's machine even if a future PR introduces a route that bypasses the JWT interceptor.
2. **No JWT-exempt routes (hard rule):** the JWT interceptor (§4) MUST apply to **every** route on the remote TCP listener. There is no allowlist, no `/healthz`-style bypass, no per-method exemption. Adding any route that bypasses JWT on the prod TCP listener requires an explicit amendment to this chapter (chapter 05 §5) and the chapter 02 §8 threat model. The transport-tag local-bypass mechanism in §4 applies ONLY to the local-pipe listener; the prod TCP listener carries the `'remote-tcp'` transport tag and JWT validation is unconditional.
3. **CI lint (gate):** a CI step greps the daemon's Connect server registration for any interceptor-skipping pattern on the prod TCP listener and fails the build on match. Mirrors the dev-listener gate in chapter 04 §5.

**Why three listeners and not two:** the local data-socket and remote TCP serve identical Connect handlers but have different transport tags (per §4). One Http2Server per listener; both register the same Connect routes. Marginal extra code (~30 LOC).

**Tunnel-side TLS:** terminated at Cloudflare. Daemon-to-`cloudflared` is plain HTTP over loopback (no TLS). Connection from Cloudflare edge to `cloudflared` (the outbound tunnel) is TLS, managed by `cloudflared`.

## 6. Setup flow (first-time user)

In v0.4, enabling remote access is a **one-time wizard** in Settings:

1. User opens Electron Settings → "Remote access" pane.
2. Toggle "Enable remote access" → wizard launches.
3. Step 1: "Open Cloudflare dashboard, create a tunnel, paste the token here." (Link button opens browser to https://one.dash.cloudflare.com/tunnels.)
4. Step 2: "Create an Access application protecting the tunnel hostname; paste team name + application AUD here." (Link button opens https://one.dash.cloudflare.com/access.)
5. Step 3 (**optional, convenience-only — per R1 P1-1**): "(Optional) deploy the web client. Open this link to fork the ccsm Pages project, or enter your existing Pages URL." The wizard's success criterion is **steps 1+2 complete**; step 3 is a convenience link only and may be skipped. Pages deploy is documented end-to-end in chapter 04 §4 — the wizard link does not introduce a new product surface, just routes the user to that path.
6. Daemon stores the tunnel token and AUD via the keychain channel (§6.1), team name in SQLite, restarts the remote ingress, spawns `cloudflared`, and shows the resolved tunnel hostname + Pages URL on the Settings pane.

**Why a wizard, not a fully automated flow:** Cloudflare's account-level resources (tunnels, Access apps, Pages projects) require account-level API tokens that we'd otherwise need to ask the user to generate and paste in. A guided wizard with copy-paste is less powerful than automation but doesn't ask the user to give us a privileged API token.

**Why three steps and not one:** each Cloudflare resource (Tunnel, Access app, Pages project) is independent in the dashboard. Trying to bundle them into one click would require account-API access. Three small copy-pastes are tractable.

**v0.5+ improvement:** if the user grants an API token, we can auto-create all three. v0.4 doesn't ship that.

**Idempotency:** re-running the wizard overwrites existing values. Daemon restarts the remote ingress on every save.

**Disabling remote access:** Settings toggle → daemon stops `cloudflared`, closes the prod TCP listener. `cloudflared` outbound connection terminates; tunnel hostname returns 1033 ("Argo Tunnel error"). Resources stay in the Cloudflare account (tunnel + Access app + Pages); they just stop being routed to. **Disabling does NOT touch any local data socket, local PTY sessions, or Electron renderer state** (per R1 P2-1). The Electron client continues to operate exactly as before; only the web ingress is removed.

**Wizard scope discipline (per R1 P1-1):** v0.4 ships the **minimum** wizard needed to capture the three values (tunnel token, team name, app AUD) and the optional Pages link. **No copy A/B testing, no inline-help video embedding, no progress animations beyond a basic spinner. UX iteration is a v0.5+ slice** if real users (not the author) onboard. Implementers and contributors MUST NOT add polish work to the wizard inside the v0.4 milestone.

### 6.1 Secret-handling discipline (per R2 P0-1)

The tunnel token is a **long-lived high-stakes credential**: token compromise lets an attacker spawn their own `cloudflared` with the token and re-route the user's tunnel hostname to attacker-controlled infrastructure (DoS / phishing the user's own GitHub OAuth flow).

**Storage scheme (lock):**
1. **Tunnel token** is stored ONLY in the OS keychain. SQLite holds a non-secret pointer `cloudflare_token_keyring_id = "ccsm.tunnel.token"`. Daemon fetches from the keychain on demand; **never persists plaintext to SQLite or disk**.
2. **CF AUD** is sensitive (allows replay-validation of intercepted JWTs against the wrong app); stored alongside the token in the keychain under `ccsm.access.aud`. Same fetch discipline.
3. **Team name** is NOT a secret (visible in any Access redirect URL); stored plain in SQLite (`settings.cloudflare_team_name`).
4. **Library:** `keytar` (or a current-maintained equivalent verified at implementation time — `keytar` is in unmaintained-warning state as of 2026-04; the implementation worker MUST verify and pick the live alternative if needed).

**Per-OS backing store:**
- Windows: Credential Manager (per-user scope; threat model per chapter 02 R2 — any same-user process can read it).
- macOS: Keychain (per-user, login keychain; ACL pinned to the daemon binary signature).
- Linux: `libsecret` (gnome-keyring or kwallet via D-Bus secret-service).

**Linux-without-secret-service fallback:** if `libsecret` (or any working secret-service) is unavailable, **daemon refuses to enable remote access**. Surfaces an error in the wizard: "Remote access requires a desktop secret service (gnome-keyring or kwallet). Install + unlock one, then retry." **No plaintext fallback.** Documented for headless Linux: install `gnome-keyring`, unlock via `dbus-launch`, or accept that remote access requires a desktop session. (Headless Linux is N5 in chapter 01; this fallback rule is the explicit consequence of that N for v0.4.)

**In-memory handling:**
- Token + AUD held in a `SecureBuffer` (zeroed after use).
- **Never written to logs**; pino redaction config explicitly redacts any field name matching `/(token|secret|jwt|aud|password|authorization)/i`. Lock here; configured in chapter 02's interceptor logging section.
- **Never serialized to JSON** for IPC.
- RPC handlers that "check whether a token exists" return a `boolean` (existence), never the value.

**Setup-wizard secret-input channel:**
- Settings UI uses `<input type="password">` with `autocomplete="off"` and `autocapitalize="off"`.
- On submit, the value is sent via a **dedicated Connect RPC** (`SaveTunnelToken`, separate from the generic settings RPC) that:
  - Immediately stores to the keychain.
  - Zeroes the in-memory copy in main + renderer.
  - Returns success/failure only — never the value.
- Renderer **never re-reads** the value (the password input shows `••••••••` placeholder + a "Replace" button; replacing requires re-entry).
- IPC bridge MUST NOT log this RPC's argument; instrumentation that mirrors all RPCs to a debug log MUST exclude `SaveTunnelToken` from the mirror.

## 7. Cost

All-Cloudflare, all-free-tier (with caveats — see §7.1):

| Service | Free tier limit | Our usage |
|---|---|---|
| Tunnel | "Unlimited" bandwidth, 1 free tunnel per account | 1 tunnel |
| Pages | 500 builds/month, unlimited static hosting | <30 builds/month expected |
| Access | ≤50 users (≤3 zero-trust seats free; more on Free Plan) | 1 user |
| DNS | unlimited | not used in default config (cfargotunnel) |

**Total recurring cost: $0/month** for the v0.4 author / single-user case **assuming the bandwidth caveats below hold**.

**When you'd start paying:**
- More than 50 Access users → $7/user/month (Cloudflare Zero Trust Pay-As-You-Go). Far in the future.
- Custom domain not on Cloudflare DNS → small annual registrar fee (independent of Cloudflare).
- High build frequency → Pages charges $0.10 per 1000 builds beyond 500/month. Not realistic for this project.

### 7.1 Bandwidth caveat + spike requirement (per R4 P0-1)

Cloudflare's "unlimited bandwidth" claim for Tunnel free tier is operationally true for typical traffic but the Zero Trust TOS includes an "abusive use" clause that has historically been triggered by **always-on, high-volume continuous streaming**. v0.4 streams PTY output 24/7 across multiple sessions × multi-client fanout × 90s heartbeats — exactly the always-on pattern that warrants verification.

**Estimated monthly bandwidth (typical):**
- Heartbeats: `90s heartbeat × 5 streams × ~50 bytes × 30 days` ≈ **0.7 MB/month** (negligible).
- Idle PTY output: a few KB/day per session (prompt redraws).
- Peak PTY output: bounded by user activity (compile output, large file `cat`, dev-server log streams). Bounded at ~10 MB per heavy session-day in practice.
- **Order-of-magnitude estimate: 1–5 GB/month** for typical author use; well under any documented soft-limit Cloudflare has applied.

**Pre-M4 spike requirement:** stand up a real free-tier Tunnel and stream PTY output continuously for **7 days at typical session load**. Measure aggregate bandwidth (PTY chunks) and confirm no Cloudflare warnings or rate-limits. Spike report committed to `docs/spikes/2026-05-cloudflare-tunnel-bandwidth.md` BEFORE M4 implementation begins.

**Fallback plan (lock):** if free tier proves untenable post-spike or post-launch, switch to **paid Tunnel ($5/month base)**. Design-wise this is zero work — same Tunnel surface, just account billing flipped. User-facing change is "$0/month → $5/month"; document as a known cost-tier risk in chapter 10 R3 (which previously only worried about Access-tier risk; cross-link added).

## 8. Operational caveats

**CF Access free tier is "Cloudflare One Free" plan:** confirms ≤50 users + ≤3 zero-trust seats. As of 2026-04, this includes one IdP integration (GitHub fits) and unlimited app policies. Verify at activation time; surface a clear error in the wizard if Cloudflare changes the tier.

**`cloudflared` uses outbound HTTPS only:** no inbound port required. Works through corporate NAT / mobile hotspot / Wi-Fi captive portal (after the captive portal is dismissed).

**HTTP/2 over Tunnel (locked for v0.4):** Cloudflare Tunnel forwards HTTP/2 end-to-end (edge-to-cloudflared as HTTP/2; cloudflared-to-daemon as HTTP/1.1 OR HTTP/2 depending on cloudflared config). We force HTTP/2 by setting `--protocol http2` in `cloudflared` args. This matters for streaming (chapter 06).

**Why not QUIC/HTTP/3 for v0.4 (per R4 P2-1):** `cloudflared`'s default `--protocol auto` will pick QUIC where available, which can shave a TCP handshake on cold connections (potentially 0-RTT). Server-streaming inside QUIC works in principle but our chapter 06 streaming patterns are validated against HTTP/2 only. Locking `http2` in v0.4 removes one variable for the M4 dogfood. **Spike in M4 (deferred):** try `--protocol auto` and compare cold-start latency; if QUIC works for streaming, drop the `--protocol http2` lock in v0.5.

**Idle timeout = 100s:** Cloudflare WebSocket-equivalent (HTTP/2 stream) is killed after 100s of no traffic. We send a 90s heartbeat on every long-running stream. See chapter 06 §4.

**Connection limits:** Cloudflare doesn't publish hard caps for free Tunnel HTTP/2 stream concurrency. ccsm typical session count is single-digit. Not a concern at v0.4 scale; covered by the bandwidth spike (§7.1) for confirmation.

**Cloudflare outage:** if Cloudflare's edge or Access has an outage, the web client is unreachable. The local Electron client is unaffected (local socket). Document this as a known limitation; user has a fallback.

**Geographic latency:** Cloudflare's anycast network terminates the user's request at the nearest edge. From the edge, traffic goes through the tunnel back to the user's home box. Worst-case round-trip: edge-to-home over the user's home upstream (typically 10-40ms in metro areas). Tolerable for terminal use.

**`cloudflared --metrics` endpoint exposure (per R2 P2-1):** the `--metrics 127.0.0.1:0` ephemeral port is unauthenticated and exposes tunnel routing config to any same-user process. Bound to loopback only; hygiene-acceptable for v0.4 (info disclosure scope = tunnel stats, not RPC). v0.5 may switch to a Unix-domain socket where `cloudflared` supports it.

## 9. Testability hooks

This section lists the test hooks chapter 05's logic needs; chapter 08 owns the actual test layout.

- **`spawnCloudflared` factory injectable** (per R5 P1-1): default `childProcess.spawn`; tests substitute a fake to drive the health/restart state machine.
- **Injectable clock** for the health-poll + backoff state machine: tests advance the clock to assert (1 fail = no restart; 3 fail = restart; 10 attempts in 30 min = surface banner + slow-tick fallback; network-up event = immediate fast cycle).
- **Injectable JWKS endpoint** for the JWT validation matrix (§4.2): mock JWKS server with controllable key rotation and reachability.
- **Recorded real-CF JWT fixture** (per R5 P1-3): checked into `daemon/test/fixtures/cf-jwt-realshape.json`; re-recorded quarterly.
- **TryCloudflare local-dev path (per R5 P1-2):** for contributors without a Cloudflare account, `cloudflared tunnel --url http://127.0.0.1:7879` (TryCloudflare ephemeral mode) creates a temporary `*.trycloudflare.com` hostname with **no Access protection**. Useful for tunnel-pipe smoke tests; **NOT for the JWT path** (no Access in front means no JWT). Chapter 08 §3 documents this as the no-account fallback for spawn/supervise contract tests; CI uses the real-account path via secret credentials.
- **Stats counters (per R3 P2-2):** v0.4 carryover — `/stats` (control socket, supervisor RPC) gains counters for: connect-rpc requests/sec by method, JWT validation rejections/sec, `cloudflared` restart count, active stream count, fanout buffer total bytes. v0.5 adds a Prometheus `/metrics` endpoint.
