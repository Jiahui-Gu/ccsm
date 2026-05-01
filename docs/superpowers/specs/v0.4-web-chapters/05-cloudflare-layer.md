# 05 — Cloudflare layer (Tunnel + Access + JWT middleware)

## Context block

The web client lives on Cloudflare Pages. The user's daemon lives on their Windows box behind whatever NAT / firewall / dynamic IP that machine has. **Cloudflare Tunnel** stitches them together: the daemon (or a `cloudflared` sidecar) opens an outbound connection to Cloudflare; Cloudflare assigns a stable public hostname; HTTPS requests to that hostname are routed back over the tunnel. **Cloudflare Access** sits in front as a zero-trust authenticator: every request is intercepted, redirected to GitHub OAuth on first hit, and signed with a short-lived JWT. The daemon validates the JWT on every remote request; local-socket requests bypass it (peer-cred is the local trust boundary, see chapter 02 §8).

## TOC

- 1. Cloudflare Tunnel (`cloudflared`)
- 2. Tunnel hostname strategy
- 3. Cloudflare Access — application config
- 4. JWT validation middleware on the daemon
- 5. Local vs remote ingress on the daemon
- 6. Setup flow (first-time user)
- 7. Cost (free tier all the way)
- 8. Operational caveats

## 1. Cloudflare Tunnel (`cloudflared`)

**Decision (lock):** `cloudflared` runs as a **sidecar process spawned by the daemon** when remote access is enabled, not as a separate user-installed daemon. The daemon's binary bundle ships `cloudflared` for each platform (Win/Mac/Linux x64+ARM64) inside the package.

**Why sidecar-spawned:**
1. One install for the user — no "now install cloudflared separately".
2. Daemon owns the tunnel lifecycle: starts on remote-enable, stops on remote-disable, restarts on tunnel crash.
3. Bundling the binary means a known-good version (no "user has cloudflared 2019 from somewhere").

**Spawn args:**
```
cloudflared tunnel \
  --no-autoupdate \
  --url http://127.0.0.1:7878 \
  --metrics 127.0.0.1:0 \
  --loglevel info \
  --logfile ~/.ccsm/cloudflared.log \
  --token <stored-tunnel-token>
```

The daemon's TCP listener binds `127.0.0.1:7878` only when remote-access is enabled (see §5). `cloudflared` proxies the public Tunnel hostname to that listener.

**Tunnel auth model:** the user creates a Tunnel via the Cloudflare dashboard (one-time, in the setup wizard, see §6) and the resulting **tunnel token** (a long string) is stored in the daemon's SQLite (`settings.cloudflare_tunnel_token`, encrypted at rest with the OS keychain — Win Credential Manager / macOS Keychain / Linux `libsecret`). On daemon start, if remote-access is enabled, the token is loaded and `cloudflared` is spawned.

**Why not let the daemon create the tunnel itself via API:** Cloudflare's tunnel-create API requires an account-level API token, which the user would have to paste. The dashboard flow is one-time and uses the user's existing browser session. Less friction.

**Tunnel token rotation:** if the user revokes the token in Cloudflare dashboard, the spawned `cloudflared` exits with auth error; daemon logs and surfaces a `cloudflare.unreachable` banner in the desktop UI. User re-runs the setup wizard.

**`cloudflared` lifecycle:**
- Spawn: `child_process.spawn` with `detached: false` (dies with daemon).
- Health: poll `--metrics` HTTP endpoint every 30s; restart on 3 consecutive failures.
- Restart backoff: exponential, capped at 60s, max 10 attempts in 30 minutes; then surface error and stop trying.
- Logs: tee `cloudflared` stdout/stderr to `~/.ccsm/cloudflared.log` (rotated via pino-roll, same convention as daemon log per v0.3 frag-3.7).

## 2. Tunnel hostname strategy

**Default (lock):** Cloudflare-assigned `<random>.cfargotunnel.com` hostname (ends up looking like `e3a9b2c1.cfargotunnel.com`). Auto-provisioned at tunnel-create time; no DNS configuration needed.

**Custom domain (opt-in):** if the user owns a domain on Cloudflare DNS, they can route `daemon.<their-domain>` to the tunnel via a CNAME to `<tunnel-id>.cfargotunnel.com`. Configured via Cloudflare dashboard, not the daemon. Daemon's Settings UI just shows the active hostname read from `cloudflared`'s metrics endpoint.

**Why default to the random hostname:** zero-config. The user gets remote access from the first session of the wizard with no domain purchase or DNS setup.

**Why custom domain is opt-in only:** requires the user to own a domain. Can't be the default.

**Hostname for the web SPA (Cloudflare Pages):** separate from the tunnel hostname. Pages assigns `<project>.pages.dev` (e.g. `ccsm-app.pages.dev`); the user MAY add a custom CNAME (e.g. `app.<their-domain>`) via Pages settings. Both Pages and Tunnel hostnames go behind Cloudflare Access (§3) — same Access policy covers both.

## 3. Cloudflare Access — application config

**Application** = a Cloudflare Access "self-hosted" application protecting the tunnel hostname AND the Pages hostname.

**Identity provider:** GitHub OAuth (free, included).

**Policy (locked):**
```
include:
  - emails: ["<author's GitHub email>"]
require:
  - identity_provider: github
session_duration: 24h
auto_redirect_to_identity: true
```

**Why GitHub OAuth IdP:** the project already requires GitHub for source code; reusing the identity is zero-friction. Cloudflare Access GitHub IdP is free and stable.

**Why `auto_redirect_to_identity`:** skips Access's "pick an IdP" page since there's only one. User clicks the URL → straight to GitHub login → straight back to the app.

**Why 24h session:** balance between "doesn't make me sign in every page load" and "stale device gets locked out reasonably soon". Cloudflare default is 24h; we accept the default.

**Multi-user later (N2 in chapter 01):** when the user opens this to friends, the policy gains more emails. v0.4 keeps it single-user.

**JWT delivery:** Cloudflare Access sets the JWT in:
1. **`Cf-Access-Jwt-Assertion` HTTP request header** on every authenticated request (browser → daemon). This is what the daemon validates.
2. **`CF_Authorization` cookie** on the user's browser, so the SPA itself doesn't need to manage the token.

The web client treats the JWT as opaque — Cloudflare and the daemon handle issuance and validation respectively. No JWT parsing in the browser.

## 4. JWT validation middleware on the daemon

**Decision (lock):** Connect interceptor on the daemon's data-socket Connect server, applied **only when the request arrives via the remote (TCP/Tunnel) listener**, not the local socket.

**Implementation:**
```
// daemon/src/connect/jwt-interceptor.ts (new)
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URL = 'https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs';
const ISSUER = 'https://<team-name>.cloudflareaccess.com';
const AUDIENCE = '<application-aud-tag>';

const jwks = createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30000 });

export const jwtInterceptor: Interceptor = (next) => async (req) => {
  if (req.contextValues.get(localTransportKey)) return next(req); // local socket bypass
  const token = req.header.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new ConnectError('missing access JWT', Code.Unauthenticated);
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    req.contextValues.set(jwtPayloadKey, payload);
  } catch (err) {
    throw new ConnectError(`invalid access JWT: ${err.message}`, Code.Unauthenticated);
  }
  return next(req);
};
```

**Why `jose` library:** stable, well-audited, supports Cloudflare's JWKS format out of the box. Used by every other Node project doing JWT validation.

**Why `createRemoteJWKSet` with caching:** the JWKS endpoint is hit on first request, cached, refreshed on key rotation (Cloudflare rotates keys ~yearly). 30s cooldown on miss prevents JWKS-fetch storms under load.

**Why fail-closed (no token = reject):** the only requests that should reach this middleware are remote (Tunnel) requests, which Cloudflare Access ALWAYS adds the header to. Missing header = either misconfiguration or attacker bypassing Access. Either way, reject.

**Local bypass mechanism:** the daemon's transport selector (`runtime-root.ts`) tags incoming requests with `localTransportKey: true` when they arrive on the named-pipe / Unix-socket listener. The JWT interceptor checks this tag and short-circuits.

**Why a transport-level tag rather than per-listener interceptor:** simpler. One Connect server, one interceptor chain, one decision rule. The local listener and remote listener share handlers, transport tag differentiates.

**Bootstrap (knowing `<team-name>` and `<aud>`):** the user provides these in the setup wizard (§6) and they're stored in `settings.cloudflare_team_name` + `settings.cloudflare_app_aud` in SQLite. Daemon reads at startup; remote ingress refuses to start if either is missing.

**JWT claims used:** the daemon doesn't currently need the email claim (single user — if the JWT validates, you're authorized). Logged for audit (`pino.info({ jwt_email: payload.email, traceId })`). Multi-user (N2) adds per-claim authorization later.

## 5. Local vs remote ingress on the daemon

The daemon binds **three** listeners in v0.4:

| Listener | Address | Auth | Purpose |
|---|---|---|---|
| Control socket | `\\.\pipe\ccsm-sup` (Win) / `~/.ccsm/daemon-sup.sock` (Unix) | peer-cred + HMAC (v0.3 carryover) | Supervisor RPCs (`/healthz`, `daemon.shutdown*`, etc.) |
| Data socket (local) | `\\.\pipe\ccsm-daemon` (Win) / `~/.ccsm/daemon.sock` (Unix) | peer-cred (v0.3 §3.1.1) | Connect over HTTP/2 — Electron renderer talks here |
| Data socket (remote) | TCP `127.0.0.1:7878` (only when remote enabled) | Cloudflare Access JWT | Connect over HTTP/2 — `cloudflared` proxies external traffic here |

**Why bind TCP only when remote enabled:** least exposure. If the user never enables remote, no TCP socket is open, no `cloudflared` is running. Local-only mode = unchanged from v0.3 surface area.

**TCP bind is `127.0.0.1`, never `0.0.0.0`:** all external traffic MUST go through `cloudflared`'s outbound connection. Binding `0.0.0.0` would expose the unauth'd Connect surface (the JWT interceptor relies on requests reaching it; a direct `0.0.0.0` connection from the LAN would still get JWT checked, but binding is unnecessary and risks future misconfiguration). Localhost-only.

**Why three listeners and not two:** the local data-socket and remote TCP serve identical Connect handlers but have different transport tags (and hence different interceptor behavior — JWT bypass on local). One Http2Server per listener; both register the same Connect routes. Marginal extra code (~30 LOC).

**Tunnel-side TLS:** terminated at Cloudflare. Daemon-to-`cloudflared` is plain HTTP over loopback (no TLS). Connection from Cloudflare edge to `cloudflared` (the outbound tunnel) is TLS, managed by `cloudflared`.

## 6. Setup flow (first-time user)

In v0.4, enabling remote access is a **one-time wizard** in Settings:

1. User opens Electron Settings → "Remote access" pane.
2. Toggle "Enable remote access" → wizard launches.
3. Step 1: "Open Cloudflare dashboard, create a Tunnel, paste the token here." (Link button opens browser to https://one.dash.cloudflare.com/tunnels.)
4. Step 2: "Create an Access application protecting the tunnel hostname; paste team name + application AUD here." (Link button opens https://one.dash.cloudflare.com/access.)
5. Step 3: "(Optional) deploy the web client. Open this link to fork the ccsm Pages project, or enter your existing Pages URL." (Link button opens GitHub OAuth → Cloudflare Pages.)
6. Daemon stores all values in SQLite, restarts the remote ingress, spawns `cloudflared`, and shows the resolved tunnel hostname + Pages URL on the Settings pane.

**Why a wizard, not a fully automated flow:** Cloudflare's account-level resources (tunnels, Access apps, Pages projects) require account-level API tokens that we'd otherwise need to ask the user to generate and paste in. A guided wizard with copy-paste is less powerful than automation but doesn't ask the user to give us a privileged API token.

**Why three steps and not one:** each Cloudflare resource (Tunnel, Access app, Pages project) is independent in the dashboard. Trying to bundle them into one click would require account-API access. Three small copy-pastes are tractable.

**v0.5+ improvement:** if the user grants an API token, we can auto-create all three. v0.4 doesn't ship that.

**Idempotency:** re-running the wizard overwrites existing values. Daemon restarts the remote ingress on every save.

**Disabling remote access:** Settings toggle → daemon stops `cloudflared`, closes TCP listener. `cloudflared` outbound connection terminates; tunnel hostname returns 1033 ("Argo Tunnel error"). Resources stay in Cloudflare account (tunnel + Access app + Pages); they just stop being routed to.

## 7. Cost

All-Cloudflare, all-free-tier:

| Service | Free tier limit | Our usage |
|---|---|---|
| Tunnel | Unlimited bandwidth, 1 free tunnel per account | 1 tunnel |
| Pages | 500 builds/month, unlimited static hosting | <30 builds/month expected |
| Access | ≤50 users (≤3 zero-trust seats free, more on Free Plan) | 1 user |
| DNS | unlimited | not used in default config (cfargotunnel) |

**Total recurring cost: $0/month** for the v0.4 author / single-user case.

**When you'd start paying:**
- More than 50 Access users → $7/user/month (Cloudflare Zero Trust Pay-As-You-Go). Far in the future.
- Custom domain not on Cloudflare DNS → small annual registrar fee (independent of Cloudflare).
- High build frequency → Pages charges $0.10 per 1000 builds beyond 500/month. Not realistic for this project.

## 8. Operational caveats

**CF Access free tier is "Cloudflare One Free" plan:** confirms ≤50 users + ≤3 zero-trust seats. As of 2026-04, this includes one IdP integration (GitHub fits) and unlimited app policies. Verify at activation time; surface a clear error in the wizard if Cloudflare changes the tier.

**`cloudflared` uses outbound HTTPS only:** no inbound port required. Works through corporate NAT / mobile hotspot / Wi-Fi captive portal (after the captive portal is dismissed).

**HTTP/2 over Tunnel:** Cloudflare Tunnel forwards HTTP/2 end-to-end (edge-to-cloudflared as HTTP/2; cloudflared-to-daemon as HTTP/1.1 OR HTTP/2 depending on cloudflared config). We force HTTP/2 by setting `--protocol http2` in `cloudflared` args. This matters for streaming (chapter 06).

**Idle timeout = 100s:** Cloudflare WebSocket-equivalent (HTTP/2 stream) is killed after 100s of no traffic. We send a 90s heartbeat on every long-running stream. See chapter 06 §4.

**Connection limits:** Cloudflare doesn't publish hard caps for free Tunnel HTTP/2 stream concurrency, but anecdotally hundreds of concurrent streams are fine. ccsm typical session count is single-digit. Not a concern.

**Cloudflare outage:** if Cloudflare's edge or Access has an outage, the web client is unreachable. The local Electron client is unaffected (local socket). Document this as a known limitation; user has a fallback.

**Geographic latency:** Cloudflare's anycast network terminates the user's request at the nearest edge. From the edge, traffic goes through the tunnel back to the user's home box. Worst-case round-trip: edge-to-home over the user's home upstream (typically 10-40ms in metro areas). Tolerable for terminal use.
