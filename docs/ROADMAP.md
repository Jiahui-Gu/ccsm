# ccsm Roadmap

This document records ccsm's current auth / deployment evolution roadmap
(S0 -> S5), describing the shape of the frontend, the Tauri shell, the
Cloudflare middle layer, the local daemon, and the auth model at each
stage.

## Architecture principles (invariant across stages)

**Web and Tauri are parallel frontends, both directly connected to the
backend daemon.** Tauri's only extra responsibility is starting the
daemon (spawn + Job Object lifecycle binding); on the data path Tauri is
not involved — it is a peer client to the web browser. Subsequent stages
(including S3 cloud proxy) must preserve this peer relationship: a design
that puts Tauri on the data path (e.g. "web traffic forwarded through
Tauri") is not allowed.

---

**Current position**: S0 done (wave-1 + wave-2 main line 14/14). S1 in
progress 2/4: PR #36 wave-2.5 has landed Tauri-injected `CCSM_TOKEN` env
+ port pinned to 9876; remaining (a) move the token to `~/.ccsm/token`
(currently hard-coded), (b) the web frontend should no longer rely on
URL `?token=`.

---

## Stage S0 starting point (current state)
- Web frontend: same-origin to local daemon, token written from URL into sessionStorage
- Tauri shell: same shell spawns daemon, port 0 + one-shot random token, stdout handshake
- Cloudflare middle layer: — does not exist
- Daemon (local): mints a random token on every startup, trusts only local 127.0.0.1
- Auth: per-instance independent random token, transferred manually by the user / via Tauri stdout

## Stage S1 fixed local token
- Web frontend: read a fixed token (bundled at build time / local config), connect to daemon directly
- Tauri shell: when spawning daemon, inject CCSM_TOKEN=<fixed value> env var; port pinned to 9876
- Cloudflare middle layer: —
- Daemon (local): prefers CCSM_TOKEN env (already supported in code), port pinned
- Auth: fixed shared token stored in local ~/.ccsm/token (chmod 600)

## Stage S2 introduce cloud shell (but no cloud auth)
- Web frontend: deployed to Cloudflare Pages (https://ccsm.pages.dev), still connects directly to local daemon (http://127.0.0.1:17832)
- Tauri shell: same as S1
- Cloudflare middle layer: hosts static assets only (Pages); does not participate in auth nor proxy traffic
- Daemon (local): same as S1, but must open CORS / WS Origin allow-list to accept https://ccsm.pages.dev
- Auth: still the fixed local token

## Stage S3 cloud proxies traffic
- Web frontend: switches to wss://ccsm.pages.dev/ws/<user>; no longer aware of the local daemon address
- Tauri shell: at startup actively registers a tunnel with the cloud (Tunnel / Durable Object long connection), exposing the local daemon to the cloud
- Cloudflare middle layer: Worker + Durable Object as reverse proxy, forwarding browser requests to that user's tunnel
- Daemon (local): no longer listens on the public network; only accepts the tunnel started by Tauri. Token validation moves to the tunnel layer
- Auth: browser -> cloud still uses the fixed token; cloud -> daemon uses internal tunnel credentials

## Stage S4 cloud integrates GitHub OAuth
- Web frontend: redirects to Sign in with GitHub -> obtains a cloud-issued session cookie / JWT
- Tauri shell: at startup also runs GitHub OAuth (device flow), obtains a cloud-issued tunnel credential, and uses it to register the tunnel
- Cloudflare middle layer: adds GitHub OAuth + a user -> tunnel mapping table; validates JWTs from web requests and routes to that user's tunnel
- Daemon (local): no longer authenticates the token; trusts only the tunnel layer (mTLS / one-shot credential)
- Auth: GitHub identity. Web uses browser OAuth, Tauri uses device flow. The cloud is the sole trust anchor.

## Stage S5 end state
- Web frontend: pure SPA that only understands JWT + WS; does not know where the daemon is
- Tauri shell: background daemon process + tunnel client; registers on startup, reconnects on disconnect
- Cloudflare middle layer: full responsibility — OAuth, user <-> tunnel routing, rate limiting, audit
- Daemon (local): pure local execution body, trusts only requests from the tunnel; no independent auth
- Auth: single identity source = GitHub; credential lifecycle = OAuth refresh token
