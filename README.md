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

ccsm 支持三种部署模式, 共用同一份 `frontend-web` SPA 代码, 但分发渠道独立:

### 1. Cloudflare Pages + 本地 daemon (S2, 推荐尝鲜)

浏览器入口走 CDN 静态 SPA, daemon 仍跑在本机 loopback。SPA 在浏览器里
fetch `http://127.0.0.1:9876/*` (HTTP + WS), Cloudflare 不参与鉴权也不
代理流量。

```sh
# 1. 本机起 daemon (默认监听 127.0.0.1:9876)
node packages/daemon/dist/index.mjs

# 2. 浏览器开:
#    https://cc-sm.pages.dev
```

token bootstrap 两条路径:

- 把 daemon stdout 那行的 `?token=<t>` 拼到 Pages URL 后:
  `https://cc-sm.pages.dev/?token=<token>`, SPA 写 sessionStorage;
- 或直接开 `https://cc-sm.pages.dev/`, SPA 自动 `GET http://127.0.0.1:9876/token`
  (该接口仅对 loopback origin + Pages allow-list origin 开放) 拿 token。

约束: 仅 Chromium ≥120 / Firefox / Safari 等"把 127.0.0.1 当 secure context"的
浏览器可用; daemon 必须升级到带 PNA (Private Network Access) preflight
支持的版本 (S2 起)。

### 2. daemon-embedded (经典模式)

单进程 `ccsm` 同时 serve frontend-web bundle + daemon API/WS, 浏览器直接
开 daemon 自带的 URL。同源, 无 CORS / PNA 烦恼。

```sh
node packages/daemon/dist/index.mjs
# 终端会打:
#   ccsm ready: http://127.0.0.1:17832/?token=<token>
# 直接点开
```

适合不想配 Pages 的用户、离线环境、CI smoke。

### 3. Tauri 桌面壳

`ccsm-tauri.exe` (Rust 进程) 内嵌 webview, 启动时 spawn 本地 daemon (通过
stdout handshake 拿到 port + token), 然后让 webview 加载 daemon-served
SPA。安装包自带前端 bundle, 离线可用, 永远不 fetch Cloudflare Pages。

```sh
# 装好 ccsm-tauri 后双击启动即可, 不需要单独跑 daemon。
ccsm-tauri
```

详细架构图见 [DESIGN.md §13 Deployment Modes](./DESIGN.md#13-deployment-modes-架构图)。

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
