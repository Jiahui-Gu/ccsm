# S4 Setup — GitHub App + Secret Provisioning

S4 introduces web-side authentication for ccsm-cloud (the Cloudflare Worker / Pages
frontend). This doc covers the **manual one-time setup** required before S4-T2+
code can run. Code lives under `packages/cf-worker/`.

## Scope

This doc covers:

- Registering a GitHub App for ccsm-cloud (production + local dev callbacks).
- Generating JWT signing keys.
- Injecting credentials as Cloudflare Worker secrets (production) and `.dev.vars`
  (local dev).

Out of scope (handled by later S4 tasks):

- OAuth callback handler implementation (S4-T2).
- Device Flow handler for the desktop client (S4-T8).
- UserDO and refresh-token rotation (S4-T3+).

## Design decisions (locked by S4 plan, do not re-litigate)

- **D1**: Use a **GitHub App** (not an OAuth App). GitHub Apps support Device
  Flow, which S4-T8 needs for the desktop client login.
- **D2**: **JWT** (not cookies) for web auth. Per-tunnel JWT is signed by the
  Worker and verified by the daemon's tunnel client.
- **D3**: Issue a per-tunnel **access JWT** plus a long-lived **refresh token**.
- **D4**: `UserDO` is keyed by `github_id` (stable, immutable per GitHub user).
- **D5**: Production secrets via `wrangler secret put`. Local dev via `.dev.vars`
  (gitignored). No secrets in repo.

## Step 1 — Register GitHub App

Go to <https://github.com/settings/apps> → **New GitHub App**.

Recommended values:

| Field | Value |
|-------|-------|
| GitHub App name | `ccsm-cloud` (or any unique slug) |
| Homepage URL | `https://cc-sm.pages.dev` |
| Callback URLs | `https://cc-sm.pages.dev/api/auth/github/callback` |
|               | `http://127.0.0.1:8788/api/auth/github/callback` |
| Request user authorization (OAuth) during installation | unchecked |
| Enable Device Flow | **checked** (required for S4-T8 desktop login) |
| Webhook → Active | **unchecked** (we don't consume webhooks) |
| Where can this GitHub App be installed? | **Any account** |

**Permissions** (all default to "No access" except where noted):

- **Account permissions** → **Email addresses**: **Read-only**
- All other permissions: leave at "No access"

Click **Create GitHub App**.

### Step 1b — Capture credentials

On the newly created App's settings page:

1. Note the **Client ID** (looks like `Iv1.xxxxxxxxxxxxxxxx`).
2. Click **Generate a new client secret**. Copy the secret immediately
   (looks like `ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`); GitHub only shows
   it once.
3. **Do NOT** generate a private key — ccsm-cloud does not use GitHub App
   installations or sign JWT for GitHub API. Client ID + Client secret are
   sufficient for OAuth user-to-server and Device Flow.

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
wrangler secret put GITHUB_APP_CLIENT_ID
wrangler secret put GITHUB_APP_CLIENT_SECRET
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

GitHub App **client secret** can be rotated from the App settings page; the old
secret remains valid for a brief grace window.
