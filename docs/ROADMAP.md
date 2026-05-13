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

**Status: completed 2026-05-10.** All nine S4 tasks have shipped to the
`working` branch:

- T1 (Task #113): Cloudflare wrangler.toml + `.dev.vars` setup, OAuth client provisioning runbook (`docs/S4-SETUP.md`).
- T2 (Task #121): HS256 JWT primitives (`packages/cf-worker/src/auth/jwt.ts`) + UserDO skeleton.
- T3 (Task #140): web OAuth callback + refresh + logout (`packages/cf-worker/src/auth/webOauth.ts`).
- T4 (Task #142): GitHub device flow + tunnel-JWT mint route (`packages/cf-worker/src/auth/deviceFlow.ts`).
- T5 (Task #136): JWT routing middleware + `CCSM_AUTH_MODE` flag (`packages/cf-worker/src/auth/middleware.ts`); per-user TunnelDO id `user:<user_id>` (uuid since R-51a; was `github_id` pre-R-51). Production rolls out with `legacy` (default), flips to `jwt` once T7/T8 SPA changes are live.
- T6 (Task #133): cloud-authenticated browser identity carried inside the daemon hello frame (`X-CCSM-Identity-Login` / `X-CCSM-Identity-Id` injected by the worker, echoed by TunnelDO).
- T7 (Task #139): SPA `SignInGate` + `AuthContext` (`packages/frontend-web/src/auth/`).
- T8 (Task #141): main-UI Login button driving the device flow on demand (`packages/frontend-tauri/...`).
- T9 (Task #135): cross-user isolation cloud-e2e harness (`tools/cloud-e2e/specs/cross-user-isolation.spec.ts` + `tools/cloud-e2e/fixtures/jwt-sign.ts`); two raw WebSocket clients per user verify per-user TunnelDO routing + sid envelope isolation against `wrangler dev` running `CCSM_AUTH_MODE=jwt`. T9 also caught and fixed a subprotocol-echo gap on the daemon `/tunnel/default` 101 response that would have broken jwt-mode daemon dial-in (`packages/cf-worker/src/tunnel-do.ts`).

Production cutover ladder (S4 -> S5):

1. Deploy cf-worker with `CCSM_AUTH_MODE=legacy` (current).
2. Validate OAuth + device flow on a preview deployment; flip a single env to `CCSM_AUTH_MODE=jwt` once SPA + Tauri shells are propagating tokens.
3. Once the legacy code path has zero traffic for a full week, delete the legacy branches in `cf-worker/src/index.ts` (S5).

## Deployment topology change — Task #154 (R-49 audit P1, F-A-2), 2026-05-10

The standalone Cloudflare **Pages** project (`ccsm-worker.jiahuigu.workers.dev`) and its
reproxy Pages Function (`packages/frontend-web/functions/[[path]].ts`) have
been folded into the same Worker that owns `TunnelDO`. The Worker now uses
[Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
to serve the SPA bundle (`packages/frontend-web/dist`) directly:

- `packages/cf-worker/wrangler.toml` declares `[assets] directory = "../frontend-web/dist"` with `not_found_handling = "single-page-application"` for SPA history-mode fallback and `run_worker_first = ["/health", "/ws/default", "/tunnel/default", "/token", "/api/*"]` so dynamic paths still hit the Worker script.
- `.github/workflows/deploy-pages.yml` is removed; `.github/workflows/deploy-worker.yml` now builds `frontend-web` before `wrangler deploy` so the Worker upload includes both the script and the SPA bundle in a single atomic deploy.
- `packages/frontend-web/wrangler.toml`, `packages/frontend-web/functions/[[path]].ts`, and `packages/frontend-web/tsconfig.functions.json` are deleted.
- `ccsm-worker.jiahuigu.workers.dev` is left intact for now — this PR only prepares the Worker side. The production DNS cutover (point the canonical SPA hostname at the Worker) is a follow-up.

Why: the prior topology required two deploy pipelines, two wrangler configs, and a Pages-Function reproxy hop on every browser request that already terminated in the Worker. The folded topology halves the deploy surface and eliminates the reproxy latency.

## Stage S5 end state
- Web frontend: pure SPA that only understands JWT + WS; does not know where the daemon is
- Tauri shell: background daemon process + tunnel client; registers on startup, reconnects on disconnect
- Cloudflare middle layer: full responsibility — OAuth, user <-> tunnel routing, rate limiting, audit
- Daemon (local): pure local execution body, trusts only requests from the tunnel; no independent auth
- Auth: single identity source = GitHub; credential lifecycle = OAuth refresh token
