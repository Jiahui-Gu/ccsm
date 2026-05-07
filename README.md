# ccsm-web

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

## Tests

- **Daemon** (`packages/daemon`): `pnpm -F @ccsm/daemon test` — unit /
  integration tests for HTTP auth, WS handshake, ring buffer, replay,
  backpressure, negative paths, and lifecycle (47 + 1 skipped on win32).
- **Frontend** (`packages/frontend-web`): `pnpm -F @ccsm/frontend-web test` —
  component + session-runtime unit tests.
- **End-to-end** (`packages/e2e`): `pnpm -F @ccsm/e2e-web test` — Playwright
  specs that spin up the real daemon + Vite + browser. `p1-smoke` and
  `p3-stress` need an authed `claude` on the dev's machine (CI skips them).

## Platform support

CI runs the build + daemon/frontend tests + e2e on **ubuntu-latest** and
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
