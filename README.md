# ccsm

Local Node daemon + browser tab for managing `claude` PTY sessions.

See [DESIGN.md](./DESIGN.md) for architecture; [CHANGELOG.md](./CHANGELOG.md)
for what landed in each release.

> Status: **v0.1.0** — Phase 3 acceptance complete, walking skeleton ready.
> Multi-session orchestration, backpressure, and ring-buffer reconnect all
> wired end-to-end. See "Known limitations" below.

## Quick start

Prerequisites:

- Node 22+ (the daemon, the frontend dev server, and node-pty's prebuilds
  all target Node 22).
- pnpm 10+ (the workspace uses pnpm@10.33.2; see `package.json`).
- The `claude` CLI on `PATH`. The daemon spawns it via `node-pty`; on
  Windows it looks for `claude.cmd`.

Install + build:

```sh
pnpm install
pnpm -r build
```

Run the daemon:

```sh
node packages/daemon/dist/index.mjs
```

It prints a single line:

```
ccsm ready: http://127.0.0.1:17832/?token=<base64url>
```

Open that URL in a browser. The token is bound to the running daemon's
process; restarting mints a new one.

For local development with hot reload (frontend served by Vite, daemon
proxied):

```sh
# terminal 1
pnpm -F @ccsm/daemon dev
# terminal 2
pnpm -F @ccsm/frontend-web dev
```

Then open `http://127.0.0.1:5173/?token=<token-from-daemon-stdout>`.

## Deployment modes

ccsm supports three deployment modes that share the same `frontend-web` SPA
code but differ in how it is distributed:

### 1. Cloudflare Pages + local daemon (S2, recommended for early adopters)

The browser entry point is the static SPA on the CDN, while the daemon still
runs on the local loopback. The SPA fetches `http://127.0.0.1:9876/*`
(HTTP + WS) directly from the browser; Cloudflare neither participates in
authentication nor proxies traffic.

```sh
# 1. Start the daemon locally (defaults to listening on 127.0.0.1:9876)
node packages/daemon/dist/index.mjs

# 2. Open in a browser:
#    https://cc-sm.pages.dev
```

Two paths for token bootstrap:

- Append the `?token=<t>` from the daemon stdout line to the Pages URL:
  `https://cc-sm.pages.dev/?token=<token>`. The SPA writes it to
  sessionStorage.
- Or open `https://cc-sm.pages.dev/` directly. The SPA automatically
  `GET http://127.0.0.1:9876/token` (this endpoint is exposed only to
  loopback origins and Pages allow-list origins) to retrieve the token.

Constraints: only browsers that treat `127.0.0.1` as a secure context
(Chromium >=120 / Firefox / Safari, etc.) are supported, and the daemon
must be on a version with PNA (Private Network Access) preflight support
(S2+).

CI: every push to `main` or `working` whose diff touches
`packages/{frontend-web,ui,core,shared}` triggers
`.github/workflows/deploy-pages.yml`, which builds and deploys to
https://cc-sm.pages.dev (no manual `gh workflow run` needed). You can also
`workflow_dispatch` it manually from the Actions page (e.g. after rotating
Cloudflare env vars).

### 2. daemon-embedded (classic mode)

A single `ccsm` process serves both the frontend-web bundle and the
daemon's API/WS. The browser opens the URL the daemon prints. Same-origin,
no CORS / PNA hassle.

```sh
node packages/daemon/dist/index.mjs
# The terminal prints:
#   ccsm ready: http://127.0.0.1:17832/?token=<token>
# Click the URL.
```

Suitable for users who do not want to set up Pages, offline environments,
and CI smoke tests.

### 3. Tauri desktop shell

`ccsm-tauri.exe` (a Rust process) embeds a webview, spawns the local
daemon at startup (port + token come from the stdout handshake), then
points the webview at the daemon-served SPA. The installer ships the
frontend bundle, works offline, and never fetches Cloudflare Pages.

```sh
# After installing ccsm-tauri, double-click to launch — no separate daemon needed.
ccsm-tauri
```

Detailed architecture diagrams: see [DESIGN.md §13 Deployment Modes](./DESIGN.md#13-deployment-modes-architecture-diagrams).

#### Local Tauri dev — `CCSM_AUTH_BASE` is mandatory (R-51c / Task #169)

Per the Tauri shell's repo-agnostic ROADMAP red-line, the auth host is
**never hardcoded** — it must be injected via the `CCSM_AUTH_BASE` env
var. Without it, the in-app sign-in flows surface a clear failure
("CCSM_AUTH_BASE env not set …") instead of dialing a default host.

```sh
# Production / staging
CCSM_AUTH_BASE=https://cc-sm.pages.dev pnpm tauri dev

# Local cf-worker (run `pnpm --filter @ccsm/cf-worker dev` in another terminal)
CCSM_AUTH_BASE=http://127.0.0.1:8787 pnpm tauri dev
```

Release builds inject this value through the packaging pipeline; end
users do not need to set it manually.

See [docs/S4-SETUP.md](./docs/S4-SETUP.md#desktop-sign-in-flows-r-51--tasks-167-169)
for the full PKCE-vs-device-flow flow description.

## Tests

- **Daemon** (`packages/daemon`): `pnpm -F @ccsm/daemon test` — unit /
  integration tests for HTTP auth, WS handshake, ring buffer, replay,
  backpressure, negative paths, and lifecycle (47 + 1 skipped on win32).
- **Frontend** (`packages/frontend-web`): `pnpm -F @ccsm/frontend-web test` —
  component + session-runtime unit tests.

(Legacy `packages/e2e` Playwright suite and `packages/e2e-tauri` WDIO smoke
were removed in the S3 cleanup; a new smoke harness will land in a follow-up
task.)

## Platform support

CI runs the build + daemon/frontend tests on **ubuntu-latest** and
**windows-latest** in matrix. macOS is **unverified** — the codebase is
written to be cross-platform (process group handling, `claude.cmd` vs
`claude`, ConPTY on win32) but no CI runner exercises macOS today.
**Contributions adding macOS to the matrix are welcome.**

## Known limitations (v0.1.0)

- The session API is a single-process in-memory stub (no persistence).
  Restarting the daemon loses all sessions.
- The frontend assumes a single browser tab per session. Opening the same
  `?token=` URL twice will work — both ws clients attach to the same
  PTY — but UI state (groups, archive flags) is local and not synced.
- `p3-stress` tests sustained PAUSE/RESUME against a 500 KB+ burst. Truly
  pathological 100 MB+ bursts are out of scope for v0.1.0; the daemon's
  per-subscriber pause queue cap (1 MiB) closes 1009 instead of OOMing,
  and the client recovers via lastSeq replay — see DESIGN.md §5.
- No `/debug/rss` or other introspection endpoints — kept off the
  production attack surface. Memory health is verified indirectly via
  `lifecycle.test.ts` ("idle, no stderr, still alive after 5 s").
