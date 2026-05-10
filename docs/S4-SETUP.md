# S4 Setup — GitHub OAuth App + Secret Provisioning

S4 introduces web-side authentication for ccsm-cloud (the Cloudflare Worker /
Pages frontend). This doc covers the **manual one-time setup** required before
S4-T2+ code can run. Code lives under `packages/cf-worker/`.

## Scope

This doc covers:

- Registering a GitHub **OAuth App** for ccsm-cloud (production callback).
- Generating JWT signing keys.
- Injecting credentials as Cloudflare Worker secrets (production) and
  `.dev.vars` (local dev).

Out of scope (handled by later S4 tasks):

- OAuth callback handler implementation (S4-T2).
- Device Flow handler for the desktop client (S4-T8).
- UserDO and refresh-token rotation (S4-T3+).

## Design decisions (locked by S4 plan, do not re-litigate)

- **D1**: Use a GitHub **OAuth App** (not a GitHub App). Reason: ccsm needs
  identity only (login = "who is this user"), not repo permissions or
  installations. OAuth App is the standard "Sign in with GitHub" pattern;
  config is lighter (no install, no fine-grained permission, no webhook, no
  private key). OAuth Apps support Device Flow for the S4-T8 desktop client.
- **D2**: **JWT** (not cookies) for web auth. Per-tunnel JWT is signed by the
  Worker and verified by the daemon's tunnel client.
- **D3**: Issue a per-tunnel **access JWT** plus a long-lived **refresh token**.
- **D4**: `UserDO` is keyed by `github_id` (stable, immutable per GitHub user).
- **D5**: Production secrets via `wrangler secret put`. Local dev via
  `.dev.vars` (gitignored). No secrets in repo.

## Step 1 — Register GitHub OAuth App

Go to <https://github.com/settings/developers> → **OAuth Apps** →
**New OAuth App**.

Recommended values:

| Field | Value |
|-------|-------|
| Application name | `ccsm` |
| Homepage URL | `https://cc-sm.pages.dev` |
| Authorization callback URL | `https://cc-sm.pages.dev/api/auth/github/callback` |
| Enable Device Flow | **checked** (required for S4-T8 desktop login) |

OAuth Apps allow only **one** Authorization callback URL. We use the
production callback. See "Local dev callback" below for how local dev still
works without a second app.

Click **Register application**.

### Step 1b — Capture credentials

On the newly created App's settings page:

1. Note the **Client ID** (looks like `Iv1.xxxxxxxxxxxxxxxx`).
2. Click **Generate a new client secret**. Copy the secret immediately
   (40-char hex-ish string); GitHub only shows it once.

OAuth Apps do **not** have private keys, installations, fine-grained
permissions, or webhooks — Client ID + Client Secret are all you need.

### Local dev callback

Maintain **one** prod-only OAuth App. For local dev, exercise auth either by:

- Mocking the GitHub OAuth response in unit tests (preferred for fast
  iteration), or
- Deploying to the production Worker / Pages preview and validating the real
  end-to-end flow there.

Per user decision (2026-05-10): "one OAuth App is enough" — the maintenance
cost of a second dev-only app + extra callback URL exceeds its value, given
that mocked tests + production verification cover the same flows.

## Step 2 — Generate JWT signing keys

Two independent 32-byte random keys. Use openssl:

```bash
# Access-token signing key
openssl rand -hex 32

# Refresh-token signing key (must differ from access key)
openssl rand -hex 32
```

Keep both values; they go in step 3 / step 4. Losing them invalidates all
issued tokens (users re-login).

## Step 3 — Production secrets (Cloudflare Worker)

Run from `packages/cf-worker/`. Each command prompts for the value and stores
it encrypted on Cloudflare:

```bash
cd packages/cf-worker
wrangler secret put GITHUB_OAUTH_CLIENT_ID
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
wrangler secret put JWT_SIGNING_KEY           # 32-byte hex from step 2
wrangler secret put JWT_REFRESH_SIGNING_KEY   # 32-byte hex from step 2 (different)
```

Verify with `wrangler secret list` — should show all four names (values masked).

## Step 4 — Local dev (`.dev.vars`)

`packages/cf-worker/.dev.vars` is read by `wrangler dev` and `wrangler dev
--local`. The file is **gitignored** (see `.gitignore`).

```bash
cd packages/cf-worker
cp .dev.vars.example .dev.vars
# Edit .dev.vars with the real values from steps 1b + 2
```

Do **not** commit `.dev.vars`. If you accidentally add it, run `git rm
--cached packages/cf-worker/.dev.vars` and rotate every secret it contained.

## Verification

After steps 1-4, S4-T2 can begin OAuth callback implementation. To verify
secrets are accessible without writing code yet:

```bash
cd packages/cf-worker
wrangler secret list                # production: 4 entries
test -f .dev.vars && echo "dev OK"  # local
```

## Rotation

To rotate a secret (compromise or scheduled rotation):

1. Re-run `wrangler secret put <NAME>` with the new value (overwrites).
2. Update `.dev.vars` for any local devs.
3. For `JWT_SIGNING_KEY` / `JWT_REFRESH_SIGNING_KEY` rotation, all live tokens
   are invalidated; users re-login. Plan accordingly.

GitHub OAuth App **client secret** can be rotated from the App settings page
("Generate a new client secret"); the old secret remains valid for a brief
grace window so you can roll the new value into Cloudflare without downtime.

## Desktop sign-in flows (R-51 / Tasks #167-#169)

The Tauri shell ships with **two** sign-in paths, gated through the same
GitHub OAuth App as the web flow. The SPA (`LoginButton`) shows the PKCE
path as the primary affordance and the device-flow path as a collapsible
fallback.

### Primary — PKCE deep-link (R-51b/c)

Default for installed Windows / Linux desktops where the OS can dispatch
`ccsm://` URLs back to a running app instance.

1. User clicks **"Sign in with GitHub"**.
2. Tauri command `start_pkce_oauth` POSTs `/api/auth/desktop/start` to
   cf-worker. The worker mints a `state` + `code_verifier` (verifier
   persisted server-side in the PKCE-state UserDO role) and returns the
   GitHub authorize URL.
3. The shell opens the URL via `tauri-plugin-shell`. The user authorizes
   on github.com.
4. GitHub redirects back to `https://cc-sm.pages.dev/oauth/desktop/cb`,
   which renders a tiny bounce page that immediately navigates to
   `ccsm://oauth?token=<jwt>&refresh=<token>&state=<state>`.
5. The OS routes the deep link to the running Tauri instance (single-
   instance plugin forwards across instances). The `on_open_url` listener
   verifies `state` against `PkceStateStore`, persists the credentials to
   `~/.ccsm/tunnel_jwt`, and emits `oauth-complete`.

The JWT never travels through the SPA — only the resolved login string
crosses the IPC boundary.

### Fallback — Device flow (S4-T8 / R-51c)

Reachable from the **"Trouble signing in? Use a code instead"** link
under the primary button. The link auto-expands 5 s after a PKCE click
that has not resolved.

Same wire flow as before R-51 (Task #141): cf-worker `/api/auth/device/start`
mints a `user_code` + `verification_uri`; SPA shows the modal; Rust polls
`/api/auth/device/poll` until success or timeout.

### GitHub OAuth App configuration for desktop

The single OAuth App registered in step 1 above already supports both
desktop paths. No second app is needed:

- **Authorization callback URL**: `https://cc-sm.pages.dev/oauth/desktop/cb`
  (R-51a re-routed the desktop path to this endpoint; the legacy
  `/api/auth/github/callback` continues to serve the web flow). If your
  app was registered before R-51a, update the callback URL in the GitHub
  App settings.
- **Enable Device Flow**: must remain checked for the fallback path.

### Local dev / preview

The Tauri shell is repo-agnostic by ROADMAP red-line, so the auth host is
**injected via env**, never hardcoded:

```bash
# Production / staging
CCSM_AUTH_BASE=https://cc-sm.pages.dev pnpm tauri dev

# Local cf-worker dev
CCSM_AUTH_BASE=http://127.0.0.1:8787 pnpm tauri dev
```

Without `CCSM_AUTH_BASE`, the `start_pkce_oauth` / `start_device_oauth`
commands surface a clear `oauth-failed` event with reason
`"CCSM_AUTH_BASE env not set ..."` rather than dialing a default host.
